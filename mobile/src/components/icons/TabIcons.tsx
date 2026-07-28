import { type ComponentType } from "react";
import { Platform } from "react-native";
import { SymbolView, type SFSymbol } from "expo-symbols";
import {
  Bookmark,
  CircleArrowDown,
  House,
  Search,
  Tv,
  type LucideProps,
} from "lucide-react-native";

type Props = {
  active: boolean;
  color: string;
  size?: number;
};

function TabSymbol({
  active,
  color,
  size = 22,
  idleName,
  activeName,
  Fallback,
}: Props & {
  idleName: SFSymbol;
  activeName?: SFSymbol;
  Fallback: ComponentType<LucideProps>;
}) {
  if (Platform.OS === "ios") {
    return (
      <SymbolView
        name={active && activeName ? activeName : idleName}
        size={size}
        tintColor={color}
        type="hierarchical"
        weight={active ? "semibold" : "medium"}
        animationSpec={
          active
            ? { effect: { type: "bounce", wholeSymbol: true }, speed: 1.2 }
            : undefined
        }
        style={{ width: size, height: size }}
      />
    );
  }

  return (
    <Fallback
      size={size}
      color={color}
      strokeWidth={active ? 2.35 : 2}
      fill={active ? color : "transparent"}
    />
  );
}

export function HomeTabIcon(props: Props) {
  return <TabSymbol {...props} idleName="house" activeName="house.fill" Fallback={House} />;
}

export function SearchTabIcon(props: Props) {
  return <TabSymbol {...props} idleName="magnifyingglass" Fallback={Search} />;
}

export function LiveTabIcon(props: Props) {
  return <TabSymbol {...props} idleName="play.tv" activeName="play.tv.fill" Fallback={Tv} />;
}

export function DownloadsTabIcon(props: Props) {
  return (
    <TabSymbol
      {...props}
      idleName="arrow.down.circle"
      activeName="arrow.down.circle.fill"
      Fallback={CircleArrowDown}
    />
  );
}

export function MyListTabIcon(props: Props) {
  return <TabSymbol {...props} idleName="bookmark" activeName="bookmark.fill" Fallback={Bookmark} />;
}
