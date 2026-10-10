import { ExportLinks } from "../components/ExportLinks";
import { Card, Page } from "../components/ui";

/** Settings, Export: your full history as a file. */
export default function Export() {
  return (
    <Page title="Export" back="/settings">
      <Card title="Your full history">
        <ul className="mb-4 list-disc space-y-1 pl-5 text-sm">
          <li><span className="font-bold">CSV</span> opens in any spreadsheet and uses the same columns as a Hevy export. It has your workouts only.</li>
          <li><span className="font-bold">JSON</span> is a complete backup: every workout with all its details, plus your exercises, routines, and bars and plates.</li>
        </ul>
        <ExportLinks path="/api/export" page="/settings/export" what="your full history" />
        <p className="mt-3 text-sm text-muted">Workouts still waiting to upload from your phone show up here once they sync. To export one workout, open it in History.</p>
      </Card>
    </Page>
  );
}
