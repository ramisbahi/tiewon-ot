import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { reconstructSummary } from './backfill';
import type { Snapshot } from '../web/lib/history';
// Offline only. Never posts; published snapshots are immutable.
const [scoreboardPath,inputDir,outputDir]=process.argv.slice(2);
if(!outputDir)throw new Error('Usage: backfill-week.ts SCOREBOARD INPUT_DIR OUTPUT_DIR');
const board=JSON.parse(readFileSync(scoreboardPath,'utf8'));
const games=[];
for(const e of board.events){
 if(!e.status.type.completed)continue;
 const file=join(outputDir,`${e.id}.json`);
 const samples:Snapshot[]=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):reconstructSummary(JSON.parse(readFileSync(join(inputDir,`${e.id}.json`),'utf8')));
 if(!existsSync(file))writeFileSync(file,JSON.stringify(samples)+'\n');
 games.push({id:e.id,name:e.name,startTime:e.date,snapshots:samples.length,estimatedTimestamps:samples.filter(s=>s.timestampEstimated).length,modelVersion:samples[0].modelVersion,source:`https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=${e.id}`});
}
writeFileSync(join(outputDir,'index.ts'),games.map(g=>`import game${g.id} from './${g.id}.json';`).join('\n')+"\nimport type { Snapshot } from '../history';\nexport const backfills: Record<string, Snapshot[]> = {\n"+games.map(g=>`  '${g.id}': game${g.id} as Snapshot[],`).join('\n')+'\n};\n');
writeFileSync(join(outputDir,'week1-2026.json'),JSON.stringify({season:2026,week:1,origin:'reconstructed',excludedUnfinished:board.events.filter((e:{status:{type:{completed:boolean}}})=>!e.status.type.completed).map((e:{id:string;name:string})=>({id:e.id,name:e.name})),games},null,2)+'\n');
console.log(JSON.stringify({games:games.length,snapshots:games.reduce((n,g)=>n+g.snapshots,0),postsSent:0}));
