// 両 route (`/` と `/about`) で共有される component。§4.1 修正後は
// shared.tsx 由来の unit が単独の共有 chunk になり、両 route の初期 asset に
// 現れる (RTE-002)。HASH-008: この style を変更すると shared chunk と両 route の
// entries のみ変化し、home/about の route-local chunk は不変であること。
export function Shared() {
  return <div css={{ border: '1px solid gray', minWidth: 120 }}>shared</div>;
}
