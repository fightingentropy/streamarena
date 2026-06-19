import { MMKV } from "react-native-mmkv";

// Synchronous key-value store. The ported Zustand stores read their persisted
// settings at creation time (no hydration flash), exactly like the web app read
// `localStorage` synchronously.
const mmkv = new MMKV({ id: "streamarena-app" });

// localStorage-compatible facade so ported stores keep their try/catch
// getItem/setItem/removeItem call sites verbatim.
export const storage = {
  getItem(key: string): string | null {
    const value = mmkv.getString(key);
    return value === undefined ? null : value;
  },
  setItem(key: string, value: string): void {
    mmkv.set(key, value);
  },
  removeItem(key: string): void {
    mmkv.delete(key);
  },
  getAllKeys(): string[] {
    return mmkv.getAllKeys();
  },
};
