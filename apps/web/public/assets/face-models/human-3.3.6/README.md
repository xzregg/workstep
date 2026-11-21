# Face recognition runtime models

Pinned source: the `models/{blazeface,faceres,facemesh}.{json,bin}`
files distributed in the npm package `@vladmandic/human@3.3.6`.
The SDK is separately pinned in package.json and dynamically imported only when
face recognition is used. The package's MIT license is retained as `LICENSE`.

Upstream model implementation credits:
- BlazeFace: TensorFlow / MediaPipe face detector.
- FaceMesh: TensorFlow / MediaPipe face landmarks, used only for enrollment pose checks.
- FaceRes: HSE-FaceRes, https://github.com/HSE-asavchenko/HSE_FaceRec_tf

WorkStep embedding contract: `human-3.3.6-faceres-1024-v1`, 1024 floats.
Do not silently replace these weights while preserving that contract. Retain
model source and applicable upstream notices when updating or redistributing.
No user photos or user embeddings belong in this directory.
