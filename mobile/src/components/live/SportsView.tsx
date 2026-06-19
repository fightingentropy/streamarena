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
      style={{
        backgroundColor: colors.card,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: colors.line,
        padding: 14,
        marginHorizontal: 16,
        marginBottom: 10,
        opacity: playable ? 1 : 0.5,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 6 }}>
        {live ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
            <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: colors.accent }} />
            <Text style={{ color: colors.accent, fontSize: 11, fontWeight: "800", letterSpacing: 0.5 }}>LIVE</Text>
          </View>
        ) : (
          <Text style={{ color: colors.muted, fontSize: 11, fontWeight: "700" }}>
            {dayLabel(match.startTimestamp)} · {clockTime(match.startTimestamp)}
          </Text>
        )}
      </View>
      <Text numberOfLines={2} style={{ color: colors.foreground, fontSize: 15, fontWeight: "700" }}>
        {heading}
      </Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 6 }}>
        {meta ? <Text numberOfLines={1} style={{ color: colors.muted, fontSize: 12, flex: 1 }}>{meta}</Text> : <View style={{ flex: 1 }} />}
        {playable ? (
          <Text style={{ color: colors.muted, fontSize: 11 }}>
            {match.streams.length} {match.streams.length === 1 ? "stream" : "streams"}
          </Text>
        ) : (
          <Text style={{ color: colors.muted, fontSize: 11 }}>No stream</Text>
        )}
      </View>
    </PressableScale>
  );
}

function SectionHeader({ children }: { children: string }) {
  return (
    <Text style={{ color: colors.foreground, fontSize: 18, fontWeight: "800", marginHorizontal: 16, marginTop: 18, marginBottom: 10 }}>
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
      {/* Wrap the sport chips so every sport stays visible (no horizontal cut-off). */}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, paddingHorizontal: 16, paddingVertical: 12 }}>
        {SPORTS.map((s) => {
          const active = s.id === sport;
          return (
            <PressableScale
              key={s.id}
              onPress={() => setSport(s.id)}
              accessibilityState={{ selected: active }}
              style={{
                backgroundColor: active ? colors.accent : colors.card,
                borderColor: active ? colors.accent : colors.line,
                borderWidth: 1,
                borderRadius: 9999,
                paddingHorizontal: 14,
                paddingVertical: 8,
              }}
            >
              <Text style={{ color: active ? colors.white : colors.muted, fontSize: 13, fontWeight: "700" }}>{s.label}</Text>
            </PressableScale>
          );
        })}
      </View>

      {loading && live.length === 0 && upcoming.length === 0 ? (
        <View style={{ paddingTop: 60 }}>
          <ActivityIndicator color={colors.accent} />
        </View>
      ) : error && isEmpty ? (
        <View style={{ paddingHorizontal: 16, paddingTop: 40 }}>
          <ErrorText>Couldn't load the schedule. Pull back and try again.</ErrorText>
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
