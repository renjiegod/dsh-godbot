// macOS LaunchServices transport. Only the signed app receives capture and input descriptors.
int GBLaunchApplication(void);
int GBAttachToLauncher(int wantsFrames);
void GBWaitForLauncherExit(int channel);
const char *GBPublisherKeyDigest(void);
