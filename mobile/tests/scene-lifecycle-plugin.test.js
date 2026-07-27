const assert = require("node:assert/strict");
const test = require("node:test");

const appConfig = require("../app.json");
const { applySceneLifecycle } = require("../plugins/withSceneLifecycle");

const appDelegateFixture = `@main
class AppDelegate: ExpoAppDelegate {
  public override func application() -> Bool {
#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif
    return true
  }

  // Linking API
}
`;

test("iOS scene configuration is declared for current-SDK launches", () => {
  const manifest = appConfig.expo.ios.infoPlist.UIApplicationSceneManifest;
  assert.equal(manifest.UIApplicationSupportsMultipleScenes, false);
  assert.equal(
    manifest.UISceneConfigurations.UIWindowSceneSessionRoleApplication[0]
      .UISceneDelegateClassName,
    "$(PRODUCT_MODULE_NAME).SceneDelegate",
  );
});

test("scene lifecycle generation is idempotent and preserves React Native startup", () => {
  const generated = applySceneLifecycle(appDelegateFixture);
  assert.match(generated, /configurationForConnecting connectingSceneSession/);
  assert.match(generated, /class SceneDelegate: UIResponder, UIWindowSceneDelegate/);
  assert.match(generated, /factory\.startReactNative/);
  assert.match(generated, /RCTLinkingManager\.application/);
  assert.match(generated, /applicationDidEnterBackground/);
  assert.equal(applySceneLifecycle(generated), generated);
});
