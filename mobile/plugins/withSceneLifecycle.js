const { withAppDelegate } = require("expo/config-plugins");

const LEGACY_IOS_STARTUP = `#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif`;

const TVOS_STARTUP = `#if os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif`;

const SCENE_CONFIGURATION = `#if os(iOS)
  public func application(
    _ application: UIApplication,
    configurationForConnecting connectingSceneSession: UISceneSession,
    options: UIScene.ConnectionOptions
  ) -> UISceneConfiguration {
    let configuration = UISceneConfiguration(
      name: "Default Configuration",
      sessionRole: connectingSceneSession.role
    )
    configuration.delegateClass = SceneDelegate.self
    return configuration
  }
#endif`;

const SCENE_DELEGATE = `#if os(iOS)
class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard
      let windowScene = scene as? UIWindowScene,
      let appDelegate = UIApplication.shared.delegate as? AppDelegate,
      let factory = appDelegate.reactNativeFactory
    else {
      return
    }

    let window = UIWindow(windowScene: windowScene)
    self.window = window
    appDelegate.window = window
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions(from: connectionOptions)
    )
  }

  func sceneDidBecomeActive(_ scene: UIScene) {
    appDelegate?.applicationDidBecomeActive(UIApplication.shared)
  }

  func sceneWillResignActive(_ scene: UIScene) {
    appDelegate?.applicationWillResignActive(UIApplication.shared)
  }

  func sceneWillEnterForeground(_ scene: UIScene) {
    appDelegate?.applicationWillEnterForeground(UIApplication.shared)
  }

  func sceneDidEnterBackground(_ scene: UIScene) {
    appDelegate?.applicationDidEnterBackground(UIApplication.shared)
  }

  func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    for context in URLContexts {
      var options: [UIApplication.OpenURLOptionsKey: Any] = [
        .openInPlace: context.options.openInPlace
      ]
      if let sourceApplication = context.options.sourceApplication {
        options[.sourceApplication] = sourceApplication
      }
      if let annotation = context.options.annotation {
        options[.annotation] = annotation
      }
      _ = RCTLinkingManager.application(
        UIApplication.shared,
        open: context.url,
        options: options
      )
    }
  }

  func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
    _ = RCTLinkingManager.application(
      UIApplication.shared,
      continue: userActivity,
      restorationHandler: { _ in }
    )
  }

  private var appDelegate: AppDelegate? {
    UIApplication.shared.delegate as? AppDelegate
  }

  private func launchOptions(
    from connectionOptions: UIScene.ConnectionOptions
  ) -> [UIApplication.LaunchOptionsKey: Any]? {
    var launchOptions: [UIApplication.LaunchOptionsKey: Any] = [:]

    if let context = connectionOptions.urlContexts.first {
      launchOptions[.url] = context.url
    }

    if let activity = connectionOptions.userActivities.first {
      let activityDictionary: [AnyHashable: Any] = [
        UIApplication.LaunchOptionsKey.userActivityType: activity.activityType,
        "UIApplicationLaunchOptionsUserActivityKey": activity
      ]
      launchOptions[.userActivityDictionary] = activityDictionary
    }

    return launchOptions.isEmpty ? nil : launchOptions
  }
}
#endif`;

function applySceneLifecycle(contents) {
  if (contents.includes("class SceneDelegate: UIResponder, UIWindowSceneDelegate")) {
    return contents;
  }
  if (!contents.includes(LEGACY_IOS_STARTUP)) {
    throw new Error("Unable to find Expo's iOS startup block in AppDelegate.swift");
  }
  if (!contents.includes("  // Linking API")) {
    throw new Error("Unable to find the AppDelegate linking marker");
  }

  const withSceneStartup = contents.replace(LEGACY_IOS_STARTUP, TVOS_STARTUP);
  const withSceneConfiguration = withSceneStartup.replace(
    "  // Linking API",
    `${SCENE_CONFIGURATION}\n\n  // Linking API`,
  );
  return `${withSceneConfiguration.trimEnd()}\n\n${SCENE_DELEGATE}\n`;
}

function withSceneLifecycle(config) {
  return withAppDelegate(config, (cfg) => {
    if (cfg.modResults.language !== "swift") {
      throw new Error("StreamArena's scene lifecycle plugin requires a Swift AppDelegate");
    }
    cfg.modResults.contents = applySceneLifecycle(cfg.modResults.contents);
    return cfg;
  });
}

module.exports = withSceneLifecycle;
module.exports.applySceneLifecycle = applySceneLifecycle;
