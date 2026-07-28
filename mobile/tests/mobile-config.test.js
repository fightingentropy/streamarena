const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const appConfig = require("../app.json");
const packageConfig = require("../package.json");
const withSigning = require("../plugins/withSigning");

test("the native app displays Netflix while keeping its internal identity", () => {
  assert.equal(appConfig.expo.name, "Netflix");
  assert.equal(appConfig.expo.slug, "streamarena-mobile");
  assert.equal(appConfig.expo.scheme, "streamarena");
  assert.equal(appConfig.expo.version, "1.0.1");
  assert.equal(appConfig.expo.ios.buildNumber, "4");
  assert.equal(appConfig.expo.android.versionCode, 4);
  assert.equal(appConfig.expo.android.package, "xyz.streamarena.app");
  assert.equal(appConfig.expo.ios.bundleIdentifier, "xyz.streamarena.app");
  assert.equal(appConfig.expo.extra.apiOrigin, "https://streamarena.xyz");
  assert.equal(appConfig.expo.ios.infoPlist.CFBundleDisplayName, "Netflix");
  assert.equal(appConfig.expo.ios.infoPlist.CFBundleName, "Netflix");
  assert.match(
    appConfig.expo.ios.infoPlist.NSFaceIDUsageDescription,
    /Netflix/,
  );
  assert.equal(
    appConfig.expo.ios.infoPlist.UIViewControllerBasedStatusBarAppearance,
    true,
  );
  assert.equal(Object.hasOwn(appConfig.expo, "newArchEnabled"), false);
  assert.match(packageConfig.dependencies.expo, /^(\^|~)57\./);
  assert.match(packageConfig.dependencies["react-native"], /^0\.86\./);
  assert.match(packageConfig.dependencies["expo-glass-effect"], /^~57\./);
  assert.match(packageConfig.dependencies["expo-symbols"], /^~57\./);
  assert.ok(
    appConfig.expo.plugins.includes(
      "./plugins/withXcode27DeploymentTarget",
    ),
  );
});

test("the native launcher and splash use the Netflix N artwork", () => {
  const splashPlugin = appConfig.expo.plugins.find(
    (plugin) => Array.isArray(plugin) && plugin[0] === "expo-splash-screen",
  );
  const assetHash = (relativePath) =>
    createHash("sha256")
      .update(readFileSync(path.join(__dirname, "..", relativePath)))
      .digest("hex");

  assert.equal(appConfig.expo.icon, "./assets/images/icon.png");
  assert.deepEqual(splashPlugin, [
    "expo-splash-screen",
    {
      backgroundColor: "#000000",
      image: "./assets/images/splash-icon.png",
      imageWidth: 140,
    },
  ]);
  assert.equal(
    assetHash("assets/images/icon.png"),
    "f59fcbfdbd6a71dcc579fadb6d7829a597a1a9d5314f7db6d3609c56f9cad4bb",
  );
  assert.equal(
    assetHash("assets/images/splash-icon.png"),
    "91568cc747bcf7684977a1b796d77399783eda1cf3d4c6c6dfaa0b5b3da8a2ad",
  );
});

test("the signing plugin is a no-op when no Apple team is configured", () => {
  const previousTeam = process.env.EXPO_IOS_DEVELOPMENT_TEAM;
  delete process.env.EXPO_IOS_DEVELOPMENT_TEAM;

  try {
    const config = { ios: { bundleIdentifier: "xyz.streamarena.app" } };
    assert.equal(withSigning(config), config);
  } finally {
    if (previousTeam === undefined) delete process.env.EXPO_IOS_DEVELOPMENT_TEAM;
    else process.env.EXPO_IOS_DEVELOPMENT_TEAM = previousTeam;
  }
});

test("signing is applied only to the matching app target", () => {
  const appSettings = { PRODUCT_BUNDLE_IDENTIFIER: '"xyz.streamarena.app"' };
  const extensionSettings = { PRODUCT_BUNDLE_IDENTIFIER: "xyz.streamarena.share" };
  const project = {
    pbxXCBuildConfigurationSection() {
      return {
        appDebug: { buildSettings: appSettings },
        shareDebug: { buildSettings: extensionSettings },
        comment: "PBXBuildConfiguration section",
      };
    },
  };

  withSigning.applySigningSettings(project, "xyz.streamarena.app", "TEAM123456");

  assert.equal(appSettings.DEVELOPMENT_TEAM, "TEAM123456");
  assert.equal(appSettings.CODE_SIGN_STYLE, "Automatic");
  assert.equal(extensionSettings.DEVELOPMENT_TEAM, undefined);
  assert.equal(extensionSettings.CODE_SIGN_STYLE, undefined);
});
