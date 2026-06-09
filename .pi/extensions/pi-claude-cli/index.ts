// Live local-loading shim: re-exports the real extension entrypoint so a
// checkout of this repo can be loaded directly with `pi -e` / project `.pi`
// without installing from npm. Mirrors the pi-extension-scaffold convention.
export * from "../../../index.ts";
export { default } from "../../../index.ts";
