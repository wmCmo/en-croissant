import {
  ActionIcon,
  Badge,
  Group,
  Modal,
  Progress,
  ScrollArea,
  Stack,
  Table,
  Text,
  Tooltip,
} from "@mantine/core";
import { IconChartBar } from "@tabler/icons-react";
import { useState } from "react";
import { commands } from "@/bindings";
import { formatThemeLabel } from "@/utils/format";
import {
  buildModel,
  type PuzzleAttempt,
  ratingRange,
  stubbornThemes,
  type WeaknessModel,
} from "@/utils/weakspot";
import { getAttemptLogPath } from "@/utils/weakspotLog";

const pct = (x: number) => `${Math.round(x * 100)}%`;
const signed = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}`;

function Trend({ trend }: { trend: { early: number; late: number } | null }) {
  if (!trend) return <Text c="dimmed">–</Text>;
  const delta = trend.late - trend.early;
  // trend values are solves above/below expected per puzzle (difficulty-adjusted)
  const color = delta > 0.1 ? "teal" : delta < -0.1 ? "red" : "gray";
  const label = delta > 0.1 ? "improving" : delta < -0.1 ? "worse" : "flat";
  return (
    <Tooltip
      label={`vs expected: ${signed(trend.early)} → ${signed(trend.late)} (older half → newer half)`}
    >
      <Badge color={color} variant="light" size="sm">
        {label}
      </Badge>
    </Tooltip>
  );
}

interface UsageRow {
  label: string;
  used: number;
  total: number;
}

/** 消費 gauge: how much of each pool you have used up. */
async function usage(db: string, attempts: PuzzleAttempt[], model: WeaknessModel) {
  const ids = new Map(attempts.map((a) => [a.puzzleId, a]));
  const seen = [...ids.values()];
  const [lo, hi] = ratingRange(model.rating, 100, 100);
  const count = async (min: number, max: number, theme: string | null) => {
    const r = await commands.countPuzzles(db, min, max, theme);
    return r.status === "ok" ? r.data : 0;
  };
  const inRange = (a: PuzzleAttempt) => a.rating >= lo && a.rating <= hi;
  const focus = stubbornThemes(model);
  const rows: UsageRow[] = [
    { label: "Whole database", used: seen.length, total: await count(0, 4000, null) },
    {
      label: `Near your rating (${lo}–${hi})`,
      used: seen.filter(inRange).length,
      total: await count(lo, hi, null),
    },
  ];
  for (const theme of focus) {
    rows.push({
      label: `${formatThemeLabel(theme)} near your rating`,
      used: seen.filter((a) => inRange(a) && a.themes.includes(theme)).length,
      total: await count(lo, hi, theme),
    });
  }
  return rows;
}

function UsageGauge({ rows }: { rows: UsageRow[] }) {
  return (
    <Stack gap={6}>
      <Text size="sm" fw={600}>
        Puzzles used
      </Text>
      {rows.map((r) => {
        const share = r.total > 0 ? r.used / r.total : 0;
        return (
          <div key={r.label} data-testid="weakspot-usage">
            <Group justify="space-between" gap="xs">
              <Text size="xs">{r.label}</Text>
              <Text size="xs" c="dimmed">
                {r.used.toLocaleString()} / {r.total.toLocaleString()} (
                {share < 0.001 ? (share * 100).toFixed(3) : (share * 100).toFixed(1)}%)
              </Text>
            </Group>
            {/* min 0.5% so a sliver is visible even when barely started */}
            <Progress value={r.used > 0 ? Math.max(share * 100, 0.5) : 0} size="sm" />
          </div>
        );
      })}
    </Stack>
  );
}

function WeakspotStats({ db, attempts }: { db: string | null; attempts: PuzzleAttempt[] }) {
  const [opened, setOpened] = useState(false);
  const [model, setModel] = useState<WeaknessModel | null>(null);
  const [rows, setRows] = useState<UsageRow[] | null>(null);
  const [path, setPath] = useState("");

  async function open() {
    setOpened(true);
    setRows(null);
    const m = buildModel(attempts);
    setModel(m);
    setPath(await getAttemptLogPath());
    if (db) setRows(await usage(db, attempts, m));
  }

  return (
    <>
      <Tooltip label="Weak spots">
        <ActionIcon onClick={open} aria-label="Weak spots">
          <IconChartBar size={20} />
        </ActionIcon>
      </Tooltip>
      <Modal opened={opened} onClose={() => setOpened(false)} title="Weak spots" size="xl">
        {!model ? (
          <Text c="dimmed">Loading…</Text>
        ) : model.attempts === 0 ? (
          <Text c="dimmed">No puzzle attempts logged yet. Solve a few puzzles first.</Text>
        ) : (
          <Stack gap="sm">
            <Group gap="xl">
              <Text size="sm">
                Attempts: <b>{model.attempts}</b>
              </Text>
              <Text size="sm">
                Solved: <b>{pct(model.overallRate)}</b>
              </Text>
              <Text size="sm">
                Your rating: <b>{model.rating ?? "–"}</b>
              </Text>
            </Group>
            <Text size="sm">
              Not improving (focus drill):{" "}
              <b>
                {stubbornThemes(model).map(formatThemeLabel).join(" · ") ||
                  "not enough attempts yet"}
              </b>
            </Text>
            {db &&
              (rows ? (
                <UsageGauge rows={rows} />
              ) : (
                <Text size="xs" c="dimmed">
                  Counting puzzles…
                </Text>
              ))}
            <Text size="xs" c="dimmed">
              Weakest first. "Adjusted" pulls themes with few attempts toward your overall rate; "vs
              expected" is solves per attempt above (+) or below (−) what your rating predicts for
              those puzzle ratings.
            </Text>
            <ScrollArea.Autosize mah="60vh">
              <Table striped highlightOnHover stickyHeader>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Theme</Table.Th>
                    <Table.Th ta="right">Attempts</Table.Th>
                    <Table.Th ta="right">Solved</Table.Th>
                    <Table.Th ta="right">Adjusted</Table.Th>
                    <Table.Th ta="right">vs expected</Table.Th>
                    <Table.Th ta="right">Avg rating</Table.Th>
                    <Table.Th ta="right">Median solve</Table.Th>
                    <Table.Th>Trend</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {model.themes.map((t) => (
                    <Table.Tr key={t.theme} data-theme={t.theme}>
                      <Table.Td>{formatThemeLabel(t.theme)}</Table.Td>
                      <Table.Td ta="right">{t.attempts}</Table.Td>
                      <Table.Td ta="right">{pct(t.rate)}</Table.Td>
                      <Table.Td ta="right" fw={600}>
                        {pct(t.adjustedRate)}
                      </Table.Td>
                      <Table.Td ta="right" c={t.vsExpected < 0 ? "red" : "teal"}>
                        {t.vsExpected >= 0 ? "+" : ""}
                        {t.vsExpected.toFixed(2)}
                      </Table.Td>
                      <Table.Td ta="right">{t.avgRating}</Table.Td>
                      <Table.Td ta="right">
                        {t.medianSolveMs !== null ? `${(t.medianSolveMs / 1000).toFixed(1)}s` : "–"}
                      </Table.Td>
                      <Table.Td>
                        <Trend trend={t.trend} />
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </ScrollArea.Autosize>
            <Text size="xs" c="dimmed">
              Log: {path}
            </Text>
          </Stack>
        )}
      </Modal>
    </>
  );
}

export default WeakspotStats;
