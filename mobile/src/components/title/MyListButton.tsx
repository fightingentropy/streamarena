import { useEffect } from "react";
import { Check, Plus } from "lucide-react-native";
import { DetailAction } from "@/components/title/ActionRow";
import { useAccountScopeOrNull, useSignedIn } from "@/lib/auth";
import { type MyListItem } from "@/lib/streamarena";
import { selectionAsync } from "@/lib/haptics";
import { useIsSaved, useMyListStore } from "@/store/mylist";
import { colors } from "@/theme";

// The detail-screen "My List" toggle. Reads/writes the optimistic My List store and
// hydrates it for the current account on mount. Disabled when not signed in (gated on
// real auth status, not scope truthiness — useAccountScope() is never empty).
export function MyListButton({ item }: { item: MyListItem }) {
  const signedIn = useSignedIn();
  const accountScope = useAccountScopeOrNull();
  const saved = useIsSaved(item.itemIdentity);
  const toggle = useMyListStore((s) => s.toggle);

  useEffect(() => {
    useMyListStore.getState().hydrate(accountScope);
  }, [accountScope]);

  const onPress = () => {
    selectionAsync();
    toggle(item);
  };

  return (
    <DetailAction
      icon={
        saved ? <Check size={26} color={colors.foreground} /> : <Plus size={26} color={colors.foreground} />
      }
      label="My List"
      active={saved}
      onPress={onPress}
      disabled={!signedIn}
    />
  );
}
