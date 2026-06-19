import { type ImageSourcePropType } from "react-native";

// Bundled Live TV channel logos (ported from src-ui assets/images/live-thumbs),
// keyed by LiveChannel id. ant1 uses the PNG raster — RN/expo-image can't render the
// SVG the web ships. Channels without an entry fall back to a logo-less tile.
export const LIVE_LOGOS: Record<string, ImageSourcePropType> = {
  "bloomberg-tv-us": require("../../assets/images/live-thumbs/bloomberg-tv-us.png"),
  "bbc-news": require("../../assets/images/live-thumbs/bbc-news.jpg"),
  "sky-news": require("../../assets/images/live-thumbs/sky-news.png"),
  ert1: require("../../assets/images/live-thumbs/ert1.jpg"),
  "mega-news": require("../../assets/images/live-thumbs/mega-news.jpg"),
  ant1: require("../../assets/images/live-thumbs/ant1.png"),
  "alpha-tv": require("../../assets/images/live-thumbs/alpha-tv.png"),
  "top-news": require("../../assets/images/live-thumbs/top-news.jpg"),
  "novasports-1": require("../../assets/images/live-thumbs/novasports-1.png"),
  "novasports-2": require("../../assets/images/live-thumbs/novasports-2.png"),
  "novasports-3": require("../../assets/images/live-thumbs/novasports-3.png"),
  "novasports-4": require("../../assets/images/live-thumbs/novasports-4.png"),
  "novasports-5": require("../../assets/images/live-thumbs/novasports-5.png"),
  "novasports-6": require("../../assets/images/live-thumbs/novasports-6.png"),
};
