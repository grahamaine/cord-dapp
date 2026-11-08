// npm run badge -- <badge token address | account address>
import { checkBadge } from "../lib/badge.js";
const id = process.argv[2];
if (!id) { console.error("usage: npm run badge -- <badge|account>"); process.exit(1); }
console.log(JSON.stringify(await checkBadge(id), null, 2));
