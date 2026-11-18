import {
  ActionIcon,
  Badge,
  Group,
  Modal,
  ScrollArea,
  Stack,
  Table,
  Text,
  Tooltip,
} from "@mantine/core";
import { IconChartBar } from "@tabler/icons-react";
import { useState } from "react";
import { formatThemeLabel } from "@/utils/format";
import { buildModel, type WeaknessModel } from "@/utils/weakspot";
import { getAttemptLogPath, readAttempts } from "@/utils/weakspotLog";

const pct = (x: number) => `${Math.round(x * 100)}%`;

function Trend({ trend }: { trend: { early: number; late: number } | null }) {
  if (!trend) return <Text c="dimmed">–</Text>;
  const delta = trend.late - trend.early;
  const color = delta > 0.1 ? "teal" : delta < -0.1 ? "red" : "gray";
  const label = delta > 0.1 ? "improving" : delta < -0.1 ? "worse" : "flat";
  return (
    <Tooltip label={`${pct(trend.early)} → ${pct(trend.late)} (older half → newer half)`}>
      <Badge color={color} variant="light" size="sm">
        {label}
      </Badge>
    </Tooltip>
  );
}

function WeakspotStats() {
  const [opened, setOpened] = useState(false);
  const [model, setModel] = useState<WeaknessModel | null>(null);
  const [path, setPath] = useState("");

  async function open() {
    setOpened(true);
    const [attempts, logPath] = await Promise.all([readAttempts(), getAttemptLogPath()]);
    setModel(buildModel(attempts));
    setPath(logPath);
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
                Est. puzzle rating: <b>{model.rating ?? "–"}</b>
              </Text>
            </Group>
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
