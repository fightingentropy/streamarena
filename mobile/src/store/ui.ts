import { create } from "zustand";

// Lightweight UI state for global overlays (profile drawer, and later the player
// sheets). Kept separate from data stores so opening a menu never re-renders lists.
type UiState = {
  profileMenuOpen: boolean;
  openProfileMenu: () => void;
  closeProfileMenu: () => void;
};

export const useUiStore = create<UiState>((set) => ({
  profileMenuOpen: false,
  openProfileMenu: () => set({ profileMenuOpen: true }),
  closeProfileMenu: () => set({ profileMenuOpen: false }),
}));
