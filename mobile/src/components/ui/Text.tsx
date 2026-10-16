import { createContext, forwardRef, type ReactNode, useContext } from "react";
import {
  PixelRatio,
  StyleSheet,
  Text as NativeText,
  TextInput as NativeTextInput,
  type TextProps,
  type TextInputProps,
  useWindowDimensions,
} from "react-native";
import { colors, typography } from "@/theme";

// Use the embedded family everywhere while retaining native text sizing,
// accessibility, refs, weight selection and NativeWind className support.
const styles = StyleSheet.create({ text: { fontFamily: typography.fontFamily } });
const FontScaleContext = createContext(PixelRatio.getFontScale());

export function TypographyProvider({ children }: { children: ReactNode }) {
  const { fontScale } = useWindowDimensions();
  return <FontScaleContext.Provider value={fontScale}>{children}</FontScaleContext.Provider>;
}

export const Text = forwardRef<NativeText, TextProps>(function Text({ style, ...props }, ref) {
  const fontScale = useContext(FontScaleContext);
  // Remeasure mounted labels when iOS Dynamic Type changes. Otherwise native
  // text can retain the previous size's bounds and clip until the next launch.
  // Only the text remounts; navigation, playback and input focus stay intact.
  return <NativeText {...props} key={fontScale} ref={ref} style={[styles.text, style]} />;
});

export const TextInput = forwardRef<NativeTextInput, TextInputProps>(function TextInput({ style, ...props }, ref) {
  return <NativeTextInput selectionColor={colors.accent} {...props} ref={ref} style={[styles.text, style]} />;
});
