import { useMemo, useState } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import { PressableScale } from "@/components/ui/PressableScale";
import { CONTENT_BOTTOM_INSET } from "@/components/ui/Screen";
import { EmptyState, ErrorText } from "@/components/ui/States";
import { SPORTS, type SportId, type SportMatch, useSportMatches } from "@/lib/live";
import { liveRequestFromMatch } from "@/video/live";
import { colors } from "@/theme";
import { useStartLive } from "./useStartLive";

function clockTime(ms: number): string {
  const d = new Date(ms);
  let h = d.getHours();
  const m = d.getMinutes().toString().padStart(2, "0");
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${m} ${ampm}`;
}

function dayLabel(ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  const tomorrow = new Date(today.getTime() + 86_400_000);
  const same = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (same(d, today)) return "Today";
  if (same(d, tomorrow)) return "Tomorrow";
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function MatchCard({ match, onPlay }: { match: SportMatch; onPlay: (m: SportMatch) => void }) {
  const live = match.startTimestamp <= Date.now() && Date.now() < match.endsAtTimestamp;
  const playable = match.streams.length > 0;
  const heading = match.team1 && match.team2 ? `${match.team1}  vs  ${match.team2}` : match.title;
  const meta = [match.league && match.league.toLowerCase() !== "streamed" ? match.league : null]
    .filter(Boolean)
    .join(" · ");
  return (
    <PressableScale
      onPress={() => onPlay(match)}
      disabled={!playable}
      scaleTo={0.99}
      style={{
        marginHorizontal: 16,
        paddingVertical: 15,
        borderBottomWidth: 0.5,
        borderBottomColor: colors.hairline,
        opacity: playable ? 1 : 0.5,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 7 }}>
        {live ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
            <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: colors.live }} />
            <Text style={{ color: colors.live, fontSize: 11, fontWeight: "800", letterSpacing: 0.6 }}>LIVE</Text>
          </View>
        ) : (
          <Text style={{ color: colors.muted, fontSize: 12, fontWeight: "600" }}>
            {dayLabel(match.startTimestamp)} · {clockTime(match.startTimestamp)}
          </Text>
        )}
      </View>
      <Text
        numberOfLines={2}
        style={{ color: colors.foreground, fontSize: 16, lineHeight: 21, fontWeight: "700", letterSpacing: -0.15 }}
      >
        {heading}
      </Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 7 }}>
        {meta ? (
          <Text numberOfLines={1} style={{ color: colors.muted, fontSize: 12, lineHeight: 17, flex: 1 }}>
            {meta}
          </Text>
        ) : (
          <View style={{ flex: 1 }} />
        )}
        {playable ? (
          <Text style={{ color: colors.muted, fontSize: 12 }}>
            {match.streams.length} {match.streams.length === 1 ? "stream" : "streams"}
          </Text>
        ) : (
          <Text style={{ color: colors.muted, fontSize: 12 }}>No stream</Text>
        )}
      </View>
    </PressableScale>
  );
}

function SectionHeader({ children }: { children: string }) {
  return (
    <Text
      style={{
        color: colors.foreground,
        fontSize: 22,
        fontWeight: "700",
        letterSpacing: -0.35,
        marginHorizontal: 16,
        marginTop: 24,
        marginBottom: 4,
      }}
    >
      {children}
    </Text>
  );
}

export function SportsView() {
  const [sport, setSport] = useState<SportId>("football");
  const { data, loading, error } = useSportMatches(sport);
  const startLive = useStartLive();

  const { live, upcoming } = useMemo(() => {
    const now = Date.now();
    // Dedupe by id — the upstream scrapers can surface the same fixture twice (e.g. a
    // MatchStream empty-slug title collision), which would otherwise collide React keys.
    const seen = new Set<string>();
    const all = (data.matches ?? [])
      .filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)))
      .sort((a, b) => a.startTimestamp - b.startTimestamp);
    return {
      live: all.filter((m) => m.startTimestamp <= now && now < m.endsAtTimestamp),
      upcoming: all.filter((m) => m.startTimestamp > now && m.endsAtTimestamp > now),
    };
  }, [data]);

  const onPlay = (m: SportMatch) => startLive(liveRequestFromMatch(m));
  const isEmpty = !loading && live.length === 0 && upcoming.length === 0;

  return (
    <View style={{ flex: 1 }}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 4, paddingBottom: 2 }}
      >
        {SPORTS.map((s) => {
          const active = s.id === sport;
          return (
            <PressableScale
              key={s.id}
              onPress={() => setSport(s.id)}
              accessibilityLabel={s.label}
              accessibilityState={{ selected: active }}
              style={{
                minHeight: 42,
                marginRight: 22,
                paddingHorizontal: 2,
                alignItems: "center",
                justifyContent: "center",
                borderBottomWidth: 1.5,
                borderBottomColor: active ? colors.foreground : "transparent",
              }}
            >
              <Text
                style={{
                  color: active ? colors.foreground : colors.muted,
                  fontSize: 14,
                  fontWeight: active ? "700" : "500",
                }}
              >
                {s.label}
              </Text>
            </PressableScale>
          );
        })}
      </ScrollView>

      {loading && live.length === 0 && upcoming.length === 0 ? (
        <View style={{ paddingTop: 60 }}>
          <ActivityIndicator color={colors.foreground} />
        </View>
      ) : error && isEmpty ? (
        <View style={{ paddingHorizontal: 16, paddingTop: 40 }}>
          <ErrorText>Couldn’t load the schedule. Pull back and try again.</ErrorText>
        </View>
      ) : isEmpty ? (
        <EmptyState title="No live or upcoming matches" subtitle="Check back closer to game time." />
      ) : (
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: CONTENT_BOTTOM_INSET }}>
          {live.length ? <SectionHeader>Live now</SectionHeader> : null}
          {live.map((m, i) => (
            <MatchCard key={`live-${m.id}-${i}`} match={m} onPlay={onPlay} />
          ))}
          {upcoming.length ? <SectionHeader>Upcoming</SectionHeader> : null}
          {upcoming.map((m, i) => (
            <MatchCard key={`up-${m.id}-${i}`} match={m} onPlay={onPlay} />
          ))}
        </ScrollView>
      )}
    </View>
  );
}
