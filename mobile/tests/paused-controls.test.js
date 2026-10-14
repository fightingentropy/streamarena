const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { runInNewContext } = require("node:vm");
const test = require("node:test");
const ts = require("typescript");

const compiled = ts.transpileModule(
  readFileSync(join(__dirname, "../src/components/player/VideoControls.tsx"), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } },
).outputText;

function renderControls(state) {
  const calls = [];
  const store = (selector) => selector(state);
  store.getState = () => ({ togglePlay: () => calls.push("play"), seekBy: (delta) => calls.push(delta) });
  const mod = { exports: {} };
  runInNewContext(compiled, {
    module: mod, exports: mod.exports, setTimeout, clearTimeout,
    require: (id) => {
      if (id === "react/jsx-runtime") return require(id);
      if (id === "react") return {
        useState: (initial) => [initial, () => {}], useRef: (current) => ({ current }),
        useCallback: (fn) => fn, useEffect() {},
      };
      if (id === "react-native") return {
        ActivityIndicator: "spinner", View: "view", Text: "text", Pressable: "pressable",
        StyleSheet: { absoluteFill: {} }, useWindowDimensions: () => ({ width: 900, height: 400 }),
      };
      if (id === "react-native-safe-area-context") return { useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) };
      if (id === "@/video/state") return { usePlayerStore: store };
      if (id === "@/theme") return { colors: {}, radius: {} };
      if (id === "@/lib/haptics") return { selectionAsync() {}, notificationError() {} };
      return new Proxy({}, { get: (_target, name) => String(name) });
    },
  });
  const nodes = [];
  function visit(node) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (typeof node.type === "function") { visit(node.type(node.props)); return; }
    nodes.push(node);
    visit(node.props?.children);
  }
  visit(mod.exports.VideoControls({ onClose() {} }));
  return { nodes, calls };
}

test("paused buffering and source loads retain working Play and skip controls", () => {
  for (const status of ["paused", "loading", "resolving"]) {
    const { nodes, calls } = renderControls({
      status, paused: true, buffering: true, position: 94, duration: 1000,
      liveSources: [], request: {}, selectedSubtitle: null,
    });
    assert.equal(nodes.some((node) => node.type === "spinner"), false);
    const play = nodes.find((node) => node.props?.accessibilityLabel === "Play");
    assert.ok(play);
    play.props.onPress();
    const skip = nodes.find((node) => node.props?.accessibilityLabel === "Skip forward 10 seconds");
    assert.ok(skip);
    skip.props.onPress();
    assert.deepEqual(calls, ["play", 10]);
  }
});

test("active playback still shows its loading indicator while buffering", () => {
  const { nodes } = renderControls({
    status: "playing", paused: false, buffering: true, position: 94, duration: 1000,
    liveSources: [], request: {}, selectedSubtitle: null,
  });
  assert.equal(nodes.some((node) => node.type === "spinner"), true);
});
