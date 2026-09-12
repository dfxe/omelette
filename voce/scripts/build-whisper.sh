#!/usr/bin/env bash
set -euo pipefail

project_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
source_dir="$project_root/vendor/whisper.cpp"

if [[ ! -d "$source_dir/.git" ]]; then
  mkdir -p "$project_root/vendor"
  git clone --depth 1 --branch v1.8.1 https://github.com/ggml-org/whisper.cpp.git "$source_dir"
fi

cmake -S "$source_dir" -B "$source_dir/build" \
  -DCMAKE_BUILD_TYPE=Release \
  -DWHISPER_BUILD_EXAMPLES=ON \
  -DWHISPER_BUILD_TESTS=OFF \
  -DGGML_VULKAN="${VOCE_VULKAN:-OFF}"
cmake --build "$source_dir/build" --target whisper-cli --parallel
cp "$source_dir/build/bin/whisper-cli" "$project_root/target/release/whisper-cli"

