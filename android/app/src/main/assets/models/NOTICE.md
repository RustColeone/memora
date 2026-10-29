# Image embedder model

`image_embedder_v1.tflite` is the MediaPipe Image Embedder model
"MobileNet-V3 (small)" (float32), downloaded unmodified from
https://storage.googleapis.com/mediapipe-models/image_embedder/mobilenet_v3_small/float32/latest/mobilenet_v3_small.tflite

- License: Apache License 2.0 (stated in the model's embedded metadata),
  https://www.apache.org/licenses/LICENSE-2.0
- Input: 224 × 224 RGB, float32 in [0, 1]. Output: 1024-value embedding.
- Memora uses it on-device only, for "Find similar" (same file as ImageDB).
