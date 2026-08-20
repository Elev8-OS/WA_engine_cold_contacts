// Gemeinsames Stylesheet für /settings und /audience.
export const PAGE_CSS = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; padding:24px; background:#0b0b0c; color:#e7e7e9;
         font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; }
  a { color:#f6bb12; }
  h1 { font-size:20px; margin:0 0 2px; letter-spacing:-.01em; }
  .sub { color:#8b8b93; font-size:12px; margin-bottom:20px; }
  .card { background:#141416; border:1px solid #24242a; border-radius:10px; padding:16px; margin-bottom:14px; }
  h2 { font-size:12px; text-transform:uppercase; letter-spacing:.08em; color:#8b8b93;
       margin:0 0 10px; font-weight:600; }
  label { display:block; font-size:11px; text-transform:uppercase; letter-spacing:.06em;
          color:#8b8b93; margin:12px 0 5px; }
  input, select { width:100%; padding:9px 11px; background:#0f0f11; color:#e7e7e9;
                  border:1px solid #2c2c34; border-radius:8px; font-size:13px; }
  button { padding:9px 16px; border-radius:8px; border:1px solid #f6bb1255;
           background:#f6bb1218; color:#f6bb12; font-size:13px; font-weight:600;
           cursor:pointer; margin:14px 8px 0 0; }
  button.ghost { border-color:#2c2c34; background:#18181b; color:#a9a9b2; }
  button:disabled { opacity:.45; cursor:default; }
  pre { background:#0f0f11; border:1px solid #24242a; border-radius:8px; padding:12px;
        overflow:auto; font-size:12px; color:#a9a9b2; margin:14px 0 0; max-height:340px;
        white-space:pre-wrap; }
  .row { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
  .dim { color:#6b6b73; } .ok { color:#22c55e; } .bad { color:#ef4444; } .warn { color:#f6bb12; }
  .kv { font-size:13px; } .kv b { color:#8b8b93; font-weight:500; }
  code { background:#0f0f11; border:1px solid #24242a; border-radius:4px; padding:1px 5px;
         font-size:12px; }
`;
