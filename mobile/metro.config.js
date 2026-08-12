// Learn more https://docs.expo.io/guides/customizing-metro
const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");
const { withNativeWind } = require("nativewind/metro");

const projectRoot = __dirname;
const sharedDir = path.resolve(projectRoot, "../shared");

const config = getDefaultConfig(projectRoot);
config.watchFolders = [...(config.watchFolders || []), sharedDir];
config.resolver.extraNodeModules = {
  ...(config.resolver.extraNodeModules || {}),
  "streamarena-shared": sharedDir,
};

module.exports = withNativeWind(config, { input: "./global.css" });
