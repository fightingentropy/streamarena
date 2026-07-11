const { withXcodeProject } = require("expo/config-plugins");

const DEVELOPMENT_TEAM_ENV = "EXPO_IOS_DEVELOPMENT_TEAM";

function unquote(value) {
  return typeof value === "string" ? value.replace(/^"|"$/g, "") : value;
}

function applySigningSettings(project, bundleIdentifier, developmentTeam) {
  const configs = project.pbxXCBuildConfigurationSection();
  for (const key of Object.keys(configs)) {
    const buildConfig = configs[key];
    const settings = buildConfig && buildConfig.buildSettings;
    if (!settings) continue;
    // Only the app target carries this bundle id; skip Pods and extensions.
    if (unquote(settings.PRODUCT_BUNDLE_IDENTIFIER) !== bundleIdentifier) continue;
    settings.DEVELOPMENT_TEAM = developmentTeam;
    settings.CODE_SIGN_STYLE = "Automatic";
  }
}

// Local device builds can opt into automatic signing by exporting
// EXPO_IOS_DEVELOPMENT_TEAM. CI and contributors without Apple credentials keep
// the generated Xcode project untouched.
function withSigning(config) {
  const developmentTeam = process.env[DEVELOPMENT_TEAM_ENV]?.trim();
  const bundleIdentifier = config.ios?.bundleIdentifier;
  if (!developmentTeam || !bundleIdentifier) return config;

  return withXcodeProject(config, (cfg) => {
    applySigningSettings(cfg.modResults, bundleIdentifier, developmentTeam);
    return cfg;
  });
}

module.exports = withSigning;
module.exports.applySigningSettings = applySigningSettings;
