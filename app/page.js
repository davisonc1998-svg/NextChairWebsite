// Server component wrapper. Forces dynamic rendering so Next.js does not try to
// statically prerender the interactive scan tool at build time (which caused a
// prerender error), then renders the client-side ScanTool.
export const dynamic = "force-dynamic";

import ScanTool from "./ScanTool";

export default function Page() {
  return <ScanTool />;
}
