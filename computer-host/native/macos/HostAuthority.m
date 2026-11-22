#import "HostAuthority.h"
#import <CommonCrypto/CommonDigest.h>
#import <Security/Security.h>
#import <pwd.h>
#import <sys/socket.h>
#import <sys/stat.h>
#import <sys/un.h>
#import <unistd.h>

// The desktop publisher key lives in a resource sealed by the Apple-signed
// application. A requesting process cannot choose the key or release directory.
extern const unsigned char GBPublisherBytes[65];
const char *GBPublisherKeyDigest(void) {
  static char result[65];
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    unsigned char digest[CC_SHA256_DIGEST_LENGTH];
    CC_SHA256(GBPublisherBytes, 65, digest);
    for (size_t i = 0; i < sizeof(digest); i++)
      snprintf(result + i * 2, 3, "%02x", digest[i]);
  });
  return result;
}
static NSString *sha256(NSString *path) {
  NSInputStream *input = [NSInputStream inputStreamWithFileAtPath:path];
  [input open];
  CC_SHA256_CTX ctx;
  CC_SHA256_Init(&ctx);
  uint8_t buffer[65536];
  NSInteger n = 0;
  while ((n = [input read:buffer maxLength:sizeof(buffer)]) > 0)
    CC_SHA256_Update(&ctx, buffer, (CC_LONG)n);
  [input close];
  if (n < 0)
    return nil;
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256_Final(digest, &ctx);
  NSMutableString *hex = [NSMutableString stringWithCapacity:64];
  for (size_t i = 0; i < sizeof(digest); i++)
    [hex appendFormat:@"%02x", digest[i]];
  return hex;
}
static BOOL regularOwned(NSString *path) {
  struct stat statbuf;
  return !lstat(path.fileSystemRepresentation, &statbuf) && S_ISREG(statbuf.st_mode) &&
         statbuf.st_uid == geteuid() && !(statbuf.st_mode & (S_IWGRP | S_IWOTH));
}
BOOL GBInstalledHostPackage(NSString *release) {
  const struct passwd *account = getpwuid(geteuid());
  if (!account || !account->pw_dir)
    return NO;
  NSString *root = [[NSString stringWithUTF8String:account->pw_dir]
      stringByAppendingPathComponent:@".local/share/godbot-computer"];
  NSString *current = [[root stringByAppendingPathComponent:@"current"] stringByResolvingSymlinksInPath];
  NSString *releases =
      [[root stringByAppendingPathComponent:@"releases"] stringByResolvingSymlinksInPath];
  NSString *path = release.stringByResolvingSymlinksInPath;
  if (![path isEqualToString:current] ||
      ![path.stringByDeletingLastPathComponent isEqualToString:releases])
    return NO;
  NSString *manifest = [path stringByAppendingPathComponent:@"manifest.json"],
           *sig = [path stringByAppendingPathComponent:@"manifest.sig"];
  if (!regularOwned(manifest) || !regularOwned(sig))
    return NO;
  NSData *data = [NSData dataWithContentsOfFile:manifest],
         *signature = [NSData dataWithContentsOfFile:sig];
  NSData *publicKey = [NSData dataWithBytes:GBPublisherBytes length:65];
  if (!data || !signature || data.length > 1024 * 1024)
    return NO;
  NSDictionary *attributes = @{
    (__bridge NSString *)kSecAttrKeyType : (__bridge NSString *)kSecAttrKeyTypeECSECPrimeRandom,
    (__bridge NSString *)kSecAttrKeyClass : (__bridge NSString *)kSecAttrKeyClassPublic,
    (__bridge NSString *)kSecAttrKeySizeInBits : @256
  };
  SecKeyRef key =
      SecKeyCreateWithData((__bridge CFDataRef)publicKey, (__bridge CFDictionaryRef)attributes, NULL);
  if (!key)
    return NO;
  BOOL valid = SecKeyVerifySignature(key, kSecKeyAlgorithmECDSASignatureMessageX962SHA256,
                                     (__bridge CFDataRef)data, (__bridge CFDataRef)signature, NULL);
  CFRelease(key);
  if (!valid)
    return NO;
  NSDictionary *m = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
  if (![m isKindOfClass:NSDictionary.class] || ![m[@"component"] isEqual:@"host"] ||
      ![m[@"platform"] isEqual:@"darwin"] || ![m[@"arch"] isEqual:@"arm64"])
    return NO;
  NSDictionary *files = m[@"files"];
  if (![files isKindOfClass:NSDictionary.class] || !files[@"runtime/bin/node"] ||
      !files[@"computer-host/cli.mjs"])
    return NO;
  NSMutableSet *remaining = [NSMutableSet setWithArray:files.allKeys];
  NSDirectoryEnumerator *entries = [NSFileManager.defaultManager enumeratorAtPath:path];
  if (!entries)
    return NO;
  for (NSString *relative in entries) {
    NSString *file = [path stringByAppendingPathComponent:relative];
    struct stat statbuf;
    if (lstat(file.fileSystemRepresentation, &statbuf) || statbuf.st_uid != geteuid() ||
        statbuf.st_mode & (S_IWGRP | S_IWOTH))
      return NO;
    if (S_ISDIR(statbuf.st_mode))
      continue;
    if (!S_ISREG(statbuf.st_mode))
      return NO;
    if ([relative isEqual:@"manifest.json"] || [relative isEqual:@"manifest.sig"])
      continue;
    if (![remaining containsObject:relative] || ![sha256(file) isEqual:files[relative]])
      return NO;
    [remaining removeObject:relative];
  }
  return remaining.count == 0;
}
BOOL GBOfficialNodePeer(int fd) {
  audit_token_t token;
  socklen_t len = sizeof(token);
  if (getsockopt(fd, SOL_LOCAL, LOCAL_PEERTOKEN, &token, &len) || len != sizeof(token))
    return NO;
  NSDictionary *attrs =
      @{(__bridge NSString *)kSecGuestAttributeAudit : [NSData dataWithBytes:&token length:len]};
  SecCodeRef peer = NULL;
  SecRequirementRef req = NULL;
  CFDictionaryRef info = NULL;
  BOOL ok = SecCodeCopyGuestWithAttributes(NULL, (__bridge CFDictionaryRef)attrs, kSecCSDefaultFlags,
                                           &peer) == errSecSuccess &&
            SecRequirementCreateWithString(CFSTR("anchor apple generic and identifier \"node\" and "
                                                 "certificate leaf[subject.OU] = \"HX7739G8FX\""),
                                           kSecCSDefaultFlags, &req) == errSecSuccess &&
            SecCodeCheckValidity(peer, kSecCSDefaultFlags, req) == errSecSuccess &&
            SecCodeCopySigningInformation(peer, kSecCSSigningInformation, &info) == errSecSuccess;
  if (ok) {
    NSDictionary *details = (__bridge NSDictionary *)info;
    ok = ([details[(__bridge NSString *)kSecCodeInfoFlags] unsignedIntValue] &
          kSecCodeSignatureRuntime) != 0;
  }
  if (info)
    CFRelease(info);
  if (req)
    CFRelease(req);
  if (peer)
    CFRelease(peer);
  return ok;
}
