const { withPodfile, withPodfileProperties } = require("expo/config-plugins");

const MINIMUM_IOS_VERSION = "16.4";
const BEGIN_MARKER =
  "    # @generated begin streamarena-xcode27-deployment-target";
const END_MARKER =
  "    # @generated end streamarena-xcode27-deployment-target";

function deploymentTargetBlock() {
  return `${BEGIN_MARKER}
    # Xcode 27 rejects Pod targets below iOS 15. Keep every generated Pod at
    # least the app/Expo deployment target while preserving any higher minimum.
    installer.pods_project.targets.each do |target|
      target.build_configurations.each do |build_config|
        current = build_config.build_settings['IPHONEOS_DEPLOYMENT_TARGET']
        if current.nil? || current.to_f < ${MINIMUM_IOS_VERSION}
          build_config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '${MINIMUM_IOS_VERSION}'
        end
      end
    end
${END_MARKER}`;
}

function applyDeploymentTargetToPodfile(contents) {
  const existingStart = contents.indexOf(BEGIN_MARKER);
  const existingEnd = contents.indexOf(END_MARKER);
  const block = deploymentTargetBlock();

  if (existingStart >= 0 && existingEnd > existingStart) {
    return (
      contents.slice(0, existingStart) +
      block +
      contents.slice(existingEnd + END_MARKER.length)
    );
  }

  const postInstallEnd = "\n  end\nend";
  const insertionPoint = contents.lastIndexOf(postInstallEnd);
  if (insertionPoint < 0) {
    throw new Error("Could not locate the Expo Podfile post_install block");
  }

  return (
    contents.slice(0, insertionPoint) +
    `\n${block}` +
    contents.slice(insertionPoint)
  );
}

function applyPrecompiledNativeDependencies(properties) {
  return {
    ...properties,
    // SDK 57 defaults to precompiled React Native and Expo XCFrameworks. Make
    // that choice explicit so stale generated properties cannot force Xcode 27
    // through the unsupported source-build path.
    "ios.buildReactNativeFromSource": "false",
  };
}

// mobile/ios is generated and git-ignored, so this config plugin is the durable
// source of the Xcode 27 CocoaPods fix on every prebuild.
module.exports = function withXcode27DeploymentTarget(config) {
  const withPrecompiledNativeDependencies = withPodfileProperties(
    config,
    (cfg) => {
      cfg.modResults = applyPrecompiledNativeDependencies(cfg.modResults);
      return cfg;
    },
  );

  return withPodfile(withPrecompiledNativeDependencies, (cfg) => {
    cfg.modResults.contents = applyDeploymentTargetToPodfile(
      cfg.modResults.contents,
    );
    return cfg;
  });
};

module.exports.applyDeploymentTargetToPodfile =
  applyDeploymentTargetToPodfile;
module.exports.applyPrecompiledNativeDependencies =
  applyPrecompiledNativeDependencies;
