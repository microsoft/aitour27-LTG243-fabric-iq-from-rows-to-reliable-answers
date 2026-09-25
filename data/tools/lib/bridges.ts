// Materialised bridge tables.
//
// Some ontology relationships are real joins in the data but span more than two
// tables, which the Fabric binding map cannot express. Rather than leave those
// edges unbound, the joins are materialised here as explicit bridge tables so
// the ontology can bind them directly and an agent can traverse them.

import { loadScenario, openCsv } from './core.ts';
import type { GenerationResult } from './core.ts';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_ROOT } from './core.ts';

type Row = Record<string, string>;

async function readCsv(relativePath: string): Promise<Row[]> {
  const text = await readFile(join(DATA_ROOT, relativePath), 'utf8');
  const lines = text.trim().split('\n');
  const header = lines[0].split(',');
  return lines.slice(1).map((line) => {
    const cells = line.split(',');
    const row: Row = {};
    header.forEach((key, index) => {
      row[key] = cells[index] ?? '';
    });
    return row;
  });
}

/**
 * Campaign -> DemandForecast.
 *
 * This is the `built_on_forecast` hop of the Act 1 evidence chain. Physically it
 * is campaigns joined to forecast_lines on region and product, then to the
 * forecast version that the campaign plan was built on. Materialising it keeps
 * the chain traversable end to end.
 */
async function generateCampaignForecastLinks(): Promise<GenerationResult> {
  const scenario = await loadScenario();
  const campaigns = await readCsv('fabric-sql/campaigns.csv');
  const forecastLines = await readCsv('fabric-sql/forecast_lines.csv');
  const forecastVersions = await readCsv('fabric-sql/forecast_versions.csv');

  const baseline = forecastVersions.find((v) => v.versionType === 'baseline');
  if (!baseline) throw new Error('No baseline forecast version found');

  const affected = new Set<string>(scenario.externalSignal.affectedRegionIds);
  const columns = [
    'campaignId',
    'forecastVersionId',
    'regionId',
    'productId',
    'forecastUnits',
    'horizonDays',
    'versionType',
    'signalAffected',
  ];
  const writer = await openCsv('fabric-sql/campaign_forecast_links.csv', columns);

  let rows = 0;
  for (const campaign of campaigns) {
    const line = forecastLines.find(
      (l) =>
        l.forecastVersionId === baseline.forecastVersionId &&
        l.regionId === campaign.regionId &&
        l.productId === campaign.productId,
    );
    if (!line) continue;
    await writer.writeRow({
      campaignId: campaign.campaignId,
      forecastVersionId: baseline.forecastVersionId,
      regionId: campaign.regionId,
      productId: campaign.productId,
      forecastUnits: Number(line.forecastUnits),
      horizonDays: Number(line.horizonDays),
      versionType: baseline.versionType,
      signalAffected: affected.has(campaign.regionId),
    });
    rows += 1;
  }
  await writer.close();

  if (rows !== campaigns.length) {
    throw new Error(
      `campaign_forecast_links: expected one row per campaign (${campaigns.length}), produced ${rows}`,
    );
  }
  return { file: 'fabric-sql/campaign_forecast_links.csv', rows };
}

export async function generateBridges(): Promise<GenerationResult[]> {
  return [await generateCampaignForecastLinks()];
}
