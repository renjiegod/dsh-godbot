#import "LaunchBridge.h"
#import "HostAuthority.h"
#import <AppKit/AppKit.h>
#import <Security/Security.h>
#import <arpa/inet.h>
#import <errno.h>
#import <fcntl.h>
#import <libproc.h>
#import <os/log.h>
#import <poll.h>
#import <signal.h>
#import <sys/socket.h>
#import <sys/stat.h>
#import <sys/sysctl.h>
#import <sys/un.h>
#import <unistd.h>

static int makeSocket(void) {
  int fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (fd >= 0) {
    int one = 1;
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof(one));
    struct timeval t = {.tv_sec = 3};
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &t, sizeof(t));
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &t, sizeof(t));
    fcntl(fd, F_SETFD, FD_CLOEXEC);
  }
  return fd;
}
static BOOL addressFor(NSString *path, struct sockaddr_un *addr) {
  const char *s = path.fileSystemRepresentation;
  if (!s || !path.isAbsolutePath || strlen(s) >= sizeof(addr->sun_path))
    return NO;
  memset(addr, 0, sizeof(*addr));
  addr->sun_family = AF_UNIX;
  strlcpy(addr->sun_path, s, sizeof(addr->sun_path));
  addr->sun_len = (uint8_t)SUN_LEN(addr);
  return YES;
}
static BOOL peerIsPID(int fd, pid_t expected) {
  pid_t pid = 0;
  uid_t uid;
  gid_t gid;
  socklen_t size = sizeof(pid);
  return expected > 1 && getpeereid(fd, &uid, &gid) == 0 && uid == geteuid() &&
         getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, &pid, &size) == 0 && pid == expected;
}
static BOOL sameSignedApp(int fd, pid_t expected) {
  if (!peerIsPID(fd, expected)) {
    os_log_error(OS_LOG_DEFAULT, "Godbot native bridge: peer PID did not match");
    return NO;
  }
  audit_token_t token;
  socklen_t size = sizeof(token);
  if (getsockopt(fd, SOL_LOCAL, LOCAL_PEERTOKEN, &token, &size) || size != sizeof(token)) {
    os_log_error(OS_LOG_DEFAULT, "Godbot native bridge: peer audit identity unavailable");
    return NO;
  }
  NSDictionary *attrs =
      @{(__bridge NSString *)kSecGuestAttributeAudit : [NSData dataWithBytes:&token length:size]};
  SecCodeRef myself = NULL, peer = NULL;
  SecRequirementRef requirement = NULL;
  BOOL ok =
      SecCodeCopySelf(kSecCSDefaultFlags, &myself) == errSecSuccess &&
      SecCodeCopyDesignatedRequirement(myself, kSecCSDefaultFlags, &requirement) == errSecSuccess &&
      SecCodeCopyGuestWithAttributes(NULL, (__bridge CFDictionaryRef)attrs, kSecCSDefaultFlags, &peer) ==
          errSecSuccess &&
      SecCodeCheckValidity(peer, kSecCSDefaultFlags, requirement) == errSecSuccess;
  if (myself)
    CFRelease(myself);
  if (peer)
    CFRelease(peer);
  if (requirement)
    CFRelease(requirement);
  if (!ok)
    os_log_error(OS_LOG_DEFAULT, "Godbot native bridge: signing requirement failed");
  return ok;
}
static BOOL exactIO(int fd, void *bytes, size_t len, BOOL writing) {
  char *p = bytes;
  while (len) {
    ssize_t n = writing ? send(fd, p, len, 0) : recv(fd, p, len, 0);
    if (n < 0 && errno == EINTR)
      continue;
    if (n <= 0)
      return NO;
    p += n;
    len -= n;
  }
  return YES;
}
static int connectLocal(NSString *path) {
  struct sockaddr_un addr;
  if (!addressFor(path, &addr))
    return -1;
  int fd = makeSocket();
  if (fd < 0)
    return -1;
  if (connect(fd, (struct sockaddr *)&addr, addr.sun_len)) {
    close(fd);
    return -1;
  }
  return fd;
}

// A stream request must originate in the packaged standalone coordinator, with a
// currently approved lease in that very process. A probe never opens a display.
static BOOL coordinatorLaunch(pid_t pid, NSString *socketPath, NSString *session) {
  if (![[NSUUID alloc] initWithUUIDString:session])
    return NO;
  char exe[PROC_PIDPATHINFO_MAXSIZE] = {0};
  if (proc_pidpath(pid, exe, sizeof(exe)) <= 0)
    return NO;
  NSString *node = [NSFileManager.defaultManager stringWithFileSystemRepresentation:exe
                                                                             length:strlen(exe)];
  NSString *release = node.stringByDeletingLastPathComponent.stringByDeletingLastPathComponent
                          .stringByDeletingLastPathComponent;
  NSString *cli = [release stringByAppendingPathComponent:@"computer-host/cli.mjs"];
  if (![node hasSuffix:@"/runtime/bin/node"] || !GBInstalledHostPackage(release))
    return NO;
  int mib[] = {CTL_KERN, KERN_PROCARGS2, pid};
  size_t length = 0;
  if (sysctl(mib, 3, NULL, &length, NULL, 0) || length <= sizeof(int) || length > 2 * 1024 * 1024)
    return NO;
  NSMutableData *argv = [NSMutableData dataWithLength:length];
  if (sysctl(mib, 3, argv.mutableBytes, &length, NULL, 0))
    return NO;
  const char *base = argv.bytes, *end = base + length, *p = base + sizeof(int);
  int argc;
  memcpy(&argc, base, sizeof(argc));
  if (argc < 3)
    return NO;
  while (p < end && *p)
    ++p;
  while (p < end && !*p)
    ++p;
  BOOL start = NO;
  for (int i = 0; i < argc && p < end; ++i) {
    size_t n = strnlen(p, end - p);
    if (n == (size_t)(end - p))
      return NO;
    NSString *arg = [[NSString alloc] initWithBytes:p length:n encoding:NSUTF8StringEncoding];
    if (i == 1 &&
        ![arg.stringByResolvingSymlinksInPath isEqualToString:cli.stringByResolvingSymlinksInPath])
      return NO;
    if (i >= 2 && [arg isEqualToString:@"start"])
      start = YES;
    p += n + 1;
  }
  if (!start)
    return NO;
  // Node and dyld load hooks must not replace the signed package's entrypoint.
  while (p < end) {
    if (!*p) {
      ++p;
      continue;
    }
    size_t n = strnlen(p, end - p);
    if (n == (size_t)(end - p))
      return NO;
    for (const char **bad = (const char *[]){"NODE_OPTIONS=", "NODE_PATH=", "DYLD_", NULL}; *bad;
         ++bad) {
      size_t k = strlen(*bad);
      if (n > k && !strncmp(p, *bad, k))
        return NO;
    }
    const char *runtime = "GODBOT_DESKTOP_RUNTIME=";
    size_t prefix = strlen(runtime);
    if (n > prefix && !strncmp(p, runtime, prefix)) {
      NSString *dir = [[NSString alloc] initWithBytes:p + prefix
                                               length:n - prefix
                                             encoding:NSUTF8StringEncoding];
      NSString *expected =
          NSBundle.mainBundle.bundleURL.URLByResolvingSymlinksInPath.URLByDeletingLastPathComponent.path;
      if (![dir.stringByResolvingSymlinksInPath isEqual:expected])
        return NO;
    }
    p += n + 1;
  }
  struct stat management, directory;
  if (lstat(socketPath.fileSystemRepresentation, &management) || !S_ISSOCK(management.st_mode) ||
      management.st_uid != geteuid() || (management.st_mode & 077) ||
      lstat(socketPath.stringByDeletingLastPathComponent.fileSystemRepresentation, &directory) ||
      !S_ISDIR(directory.st_mode) || directory.st_uid != geteuid() || (directory.st_mode & 077))
    return NO;
  int fd = connectLocal(socketPath);
  if (fd < 0)
    return NO;
  BOOL valid = NO;
  @try {
    if (!peerIsPID(fd, pid) || !GBOfficialNodePeer(fd))
      return NO;
    char query[] = "{\"method\":\"sessions\",\"args\":[]}\n";
    if (!exactIO(fd, query, sizeof(query) - 1, YES))
      return NO;
    NSMutableData *response = [NSMutableData data];
    char buf[2048];
    while (response.length < 65536) {
      ssize_t n = recv(fd, buf, sizeof(buf), 0);
      if (n < 0 && errno == EINTR)
        continue;
      if (n <= 0)
        break;
      [response appendBytes:buf length:n];
      if (memchr(buf, '\n', n))
        break;
    }
    id packet = [NSJSONSerialization JSONObjectWithData:response options:0 error:nil];
    if (![packet isKindOfClass:NSDictionary.class] || ![packet[@"ok"] isEqual:@YES] ||
        ![packet[@"result"] isKindOfClass:NSArray.class])
      return NO;
    double now = NSDate.date.timeIntervalSince1970 * 1000;
    for (id row in packet[@"result"]) {
      if ([row isKindOfClass:NSDictionary.class] && [row[@"sessionId"] isEqual:session] &&
          [row[@"mode"] isEqual:@"desktop"] && [row[@"state"] isEqual:@"approved"] &&
          [row[@"expiresAt"] doubleValue] > now) {
        valid = YES;
        break;
      }
    }
  } @finally {
    close(fd);
  }
  return valid;
}
static BOOL descriptors(int fd, BOOL sending, int count) {
  char control[CMSG_SPACE(3 * sizeof(int))] = {0};
  char b = (char)count;
  struct iovec iov = {.iov_base = &b, .iov_len = 1};
  struct msghdr msg = {.msg_iov = &iov,
                       .msg_iovlen = 1,
                       .msg_control = control,
                       .msg_controllen = CMSG_SPACE(count * sizeof(int))};
  if (sending) {
    const int fds[] = {STDIN_FILENO, STDOUT_FILENO, 3};
    struct cmsghdr *hdr = CMSG_FIRSTHDR(&msg);
    hdr->cmsg_level = SOL_SOCKET;
    hdr->cmsg_type = SCM_RIGHTS;
    hdr->cmsg_len = CMSG_LEN(count * sizeof(int));
    memcpy(CMSG_DATA(hdr), fds, count * sizeof(int));
    return sendmsg(fd, &msg, 0) == 1;
  }
  if (recvmsg(fd, &msg, 0) != 1 || b != count || (msg.msg_flags & (MSG_TRUNC | MSG_CTRUNC)))
    return NO;
  struct cmsghdr *hdr = CMSG_FIRSTHDR(&msg);
  if (!hdr || hdr->cmsg_level != SOL_SOCKET || hdr->cmsg_type != SCM_RIGHTS ||
      hdr->cmsg_len != CMSG_LEN(count * sizeof(int)))
    return NO;
  int received[3], held[3] = {-1, -1, -1}, targets[] = {0, 1, 3};
  memcpy(received, CMSG_DATA(hdr), count * sizeof(int));
  BOOL ok = YES;
  for (int i = 0; i < count; i++) {
    held[i] = fcntl(received[i], F_DUPFD_CLOEXEC, 10);
    if (held[i] < 0)
      ok = NO;
  }
  for (int i = 0; i < count; i++)
    close(received[i]);
  for (int i = 0; i < count; i++) {
    if (ok && dup2(held[i], targets[i]) < 0)
      ok = NO;
    if (held[i] >= 0)
      close(held[i]);
  }
  return ok;
}
void GBWaitForLauncherExit(int fd) {
  struct timeval timeout = {0};
  setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
  char byte;
  while (recv(fd, &byte, 1, 0) < 0 && errno == EINTR) {
  }
  close(fd);
}
int GBAttachToLauncher(int frames) {
  NSDictionary *env = NSProcessInfo.processInfo.environment;
  NSString *secret = env[@"GODBOT_MAC_LAUNCH_NONCE"], *path = env[@"GODBOT_MAC_LAUNCH_SOCKET"];
  if (![secret isKindOfClass:NSString.class] || secret.length != 64 ||
      ![path isKindOfClass:NSString.class])
    return -1;
  int low = connectLocal(path);
  if (low < 0)
    return -1;
  int link = fcntl(low, F_DUPFD_CLOEXEC, 10);
  close(low);
  if (link < 0)
    return -1;
  NSData *proof = [secret dataUsingEncoding:NSASCIIStringEncoding];
  if (!sameSignedApp(link, [env[@"GODBOT_MAC_LAUNCH_PID"] intValue]) || proof.length != 64 ||
      !exactIO(link, (void *)proof.bytes, 64, YES) || !descriptors(link, NO, frames ? 3 : 2)) {
    close(link);
    return -1;
  }
  return link;
}
int GBLaunchApplication(void) {
  NSArray *args = NSProcessInfo.processInfo.arguments;
  BOOL probe = args.count == 3 && [args[2] isEqual:@"probe"];
  BOOL stream = args.count == 10 && [args[2] isEqual:@"stream"];
  if (!probe && !stream)
    return 2;
  if (stream && !coordinatorLaunch(getppid(), args[8], args[9]))
    return 3;
  @autoreleasepool {
    char tmp[] = "/tmp/godbot-mac-XXXXXXXX";
    if (!mkdtemp(tmp))
      return 4;
    NSString *dir = [NSString stringWithUTF8String:tmp],
             *path = [dir stringByAppendingPathComponent:@"link"];
    struct sockaddr_un addr;
    int listener = -1, link = -1;
    NSRunningApplication *child = nil;
    __block NSRunningApplication *openedChild = nil;
    __block NSError *launchError = nil;

    int result = 4;
    @try {
      if (!addressFor(path, &addr))
        return 4;
      listener = makeSocket();
      if (listener < 0 || bind(listener, (struct sockaddr *)&addr, addr.sun_len) ||
          chmod(path.fileSystemRepresentation, 0600) || listen(listener, 8))
        return 4;
      uint8_t bytes[32];
      arc4random_buf(bytes, sizeof(bytes));
      NSMutableString *nonce = [NSMutableString string];
      for (size_t i = 0; i < sizeof(bytes); i++)
        [nonce appendFormat:@"%02x", bytes[i]];
      NSWorkspaceOpenConfiguration *config = NSWorkspaceOpenConfiguration.configuration;
      config.allowsRunningApplicationSubstitution = NO;
      config.createsNewApplicationInstance = YES;
      config.activates = NO;
      config.addsToRecentItems = NO;
      NSArray *operation = [args subarrayWithRange:NSMakeRange(2, probe ? 1 : 6)];
      config.arguments = [@[ @"attached" ] arrayByAddingObjectsFromArray:operation];
      config.environment = @{
        @"GODBOT_MAC_LAUNCH_SOCKET" : path,
        @"GODBOT_MAC_LAUNCH_NONCE" : nonce,
        @"GODBOT_MAC_LAUNCH_PID" : [NSString stringWithFormat:@"%d", getpid()]
      };
      NSURL *app = NSBundle.mainBundle.bundleURL.URLByResolvingSymlinksInPath;
      dispatch_semaphore_t finished = dispatch_semaphore_create(0);
      [NSWorkspace.sharedWorkspace
          openApplicationAtURL:app
                 configuration:config
             completionHandler:^(NSRunningApplication *instance, NSError *error) {
               openedChild = instance;
               launchError = error;
               dispatch_semaphore_signal(finished);
             }];
      if (dispatch_semaphore_wait(finished, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC)) != 0) {
        fprintf(stderr, "LaunchServices timed out\n");
        return 4;
      }
      child = openedChild;
      NSTimeInterval limit = NSProcessInfo.processInfo.systemUptime + 4;
      if (!child || child.processIdentifier <= 1 ||
          ![child.bundleURL.URLByResolvingSymlinksInPath.path isEqual:app.path]) {
        fprintf(stderr, "LaunchServices selected no matching bundle (%ld, instance %d, identity %d)\n",
                (long)launchError.code, child != nil,
                [child.bundleURL.URLByResolvingSymlinksInPath.path isEqual:app.path]);
        return 4;
      }
      while (NSProcessInfo.processInfo.systemUptime < limit) {
        struct pollfd wait = {.fd = listener, .events = POLLIN};
        if (poll(&wait, 1, 50) <= 0)
          continue;
        link = accept(listener, NULL, NULL);
        if (link < 0)
          continue;
        fcntl(link, F_SETFD, FD_CLOEXEC);
        if (sameSignedApp(link, child.processIdentifier))
          break;
        close(link);
        link = -1;
      }
      if (link < 0) {
        fprintf(stderr, "No authenticated app connection\n");
        return 4;
      }
      char proof[64];
      NSData *expected = [nonce dataUsingEncoding:NSASCIIStringEncoding];
      if (!exactIO(link, proof, sizeof(proof), NO)) {
        fprintf(stderr, "No launch capability response\n");
        return 4;
      }
      if (timingsafe_bcmp(proof, expected.bytes, 64) || !descriptors(link, YES, probe ? 2 : 3)) {
        fprintf(stderr, "Private descriptor handoff failed\n");
        return 4;
      }
      unlink(path.fileSystemRepresentation);
      close(listener);
      listener = -1;
      GBWaitForLauncherExit(link);
      link = -1;
      result = 0;
    } @finally {
      if (link >= 0)
        close(link);
      if (listener >= 0)
        close(listener);
      unlink(path.fileSystemRepresentation);
      rmdir(tmp);
      if (result && child && !child.terminated)
        [child terminate];
    }
    return result;
  }
}
