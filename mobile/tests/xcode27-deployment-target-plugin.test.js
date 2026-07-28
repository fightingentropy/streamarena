const assert = require("node:assert/strict");
const test = require("node:test");

const {
  applyDeploymentTargetToPodfile,
  applyPrecompiledNativeDependencies,
} = require("../plugins/withXcode27DeploymentTarget");

const podfileFixture = `target 'StreamArena' do
  use_expo_modules!

  post_install do |installer|
    react_native_post_install(installer, config[:reactNativePath])
  end
end
`;

test("Xcode 27 deployment-target generation is durable and idempotent", () => {
  const generated = applyDeploymentTargetToPodfile(podfileFixture);

  assert.match(
    generated,
    /@generated begin streamarena-xcode27-deployment-target/,
  );
  assert.match(generated, /current\.to_f < 16\.4/);
  assert.match(
    generated,
    /IPHONEOS_DEPLOYMENT_TARGET'\] = '16\.4'/,
  );
  assert.equal(applyDeploymentTargetToPodfile(generated), generated);
  assert.equal(
    generated.match(
      /@generated begin streamarena-xcode27-deployment-target/g,
    ).length,
    1,
  );
});

test("SDK 57 native generation keeps precompiled dependencies enabled", () => {
  const properties = applyPrecompiledNativeDependencies({
    "expo.jsEngine": "hermes",
  });

  assert.equal(properties["expo.jsEngine"], "hermes");
  assert.equal(properties["ios.buildReactNativeFromSource"], "false");
});

test("deployment-target generation fails closed if Expo changes its Podfile", () => {
  assert.throws(
    () => applyDeploymentTargetToPodfile("target 'StreamArena' do\nend\n"),
    /Could not locate the Expo Podfile post_install block/,
  );
});
