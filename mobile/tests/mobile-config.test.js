const assert = require("node:assert/strict");
const test = require("node:test");

const appConfig = require("../app.json");
const withSigning = require("../plugins/withSigning");

test("the native app is branded as StreamArena with valid SDK 56 config", () => {
  assert.equal(appConfig.expo.name, "StreamArena");
  assert.equal(appConfig.expo.version, "1.0.1");
  assert.equal(appConfig.expo.ios.buildNumber, "3");
  assert.equal(appConfig.expo.android.versionCode, 3);
  assert.equal(appConfig.expo.extra.apiOrigin, "https://streamarena.xyz");
  assert.equal(appConfig.expo.ios.infoPlist.CFBundleDisplayName, "StreamArena");
  assert.equal(Object.hasOwn(appConfig.expo, "newArchEnabled"), false);
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
