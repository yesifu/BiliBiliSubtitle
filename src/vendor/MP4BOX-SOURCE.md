# MP4Box.js 2.4.1

The three `.mjs` files in this directory are browser ES modules from the
pinned npm package **mp4box@2.4.1**. `LICENSE` is its BSD-3-Clause license,
reproduced verbatim. Each module has an added license/source header; the two
upstream `sourceMappingURL` comments were removed so developer tools do not
request absent source maps. Executable code is unchanged.

- Source: https://github.com/gpac/mp4box.js
- Registry metadata: https://registry.npmjs.org/mp4box/2.4.1
- Tarball: https://registry.npmjs.org/mp4box/-/mp4box-2.4.1.tgz
- Tarball SHA-512 (base64): `0HGX7nXoDIX6FKLVl4a3wtYjBlwqsN3xuQC3GXzNtKp98FXUOhDSq623azsz8DG5ptd9ZXcXodDkgbdMZOjWvw==`
- Tarball SHA-1: `9a3e9527de7fbf80208c8c3a766bc125ca01c34b`

Included from `package/dist/`: `mp4box.all.mjs`, `styp-9TIZZDLN.mjs`,
`rolldown-runtime-w6R9maHv.mjs`. No npm install, runtime network access,
WebAssembly, source maps, CommonJS bundles, or Node dependencies are needed.

The application helper uses bounded leaf-box parsing and MP4Box's M4A
writer. It deliberately reads fragment timing/offsets itself: 2.4.1's
`updateSampleLists` ignores subsequent `tfdt` values and some later `trun`
data offsets; its progressive sample-list builder also mishandles changing
`stts` durations. Vendor executable code has not been patched.

## SHA-256 module manifest

The tarball SHA-512 above was verified before vendoring.

| Module | Upstream dist SHA-256 | Vendored SHA-256 |
| --- | --- | --- |
| mp4box.all.mjs | 34fa8fd681e8b63998ca9e4c3b477830dd11310c8aaedc37ecb8f49c5452d259 | 0bca5304f0da4af3f272df24033842e7ff66ec8c1a53e8ec9eca5b02e19be3fb |
| styp-9TIZZDLN.mjs | ae15acb79233251b72af7f7cc9f47e7f47cadb209206753b7000b502a2391049 | a407650fbc40428817cac54d7ca7146c574291b24c84de8df6388634979f3c1c |
| rolldown-runtime-w6R9maHv.mjs | 183552fe973134bce551888434b581d5a2cb695a82d8907e2cd9d2b61e12ce24 | a3734dda2c92200d1422cd1e3b04012d65c3525b3c87826fd84f99ce513c85bb |
