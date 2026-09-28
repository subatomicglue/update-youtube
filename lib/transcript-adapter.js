'use strict';

// Embedded so esbuild/pkg standalone executables do not depend on repository files.
module.exports = String.raw`#!/usr/bin/env python3
"""Private backend adapter embedded by update-youtube."""

import argparse
import json
import os
from pathlib import Path

def arguments():
    parser = argparse.ArgumentParser()
    parser.add_argument("--backend", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--language", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--result", required=True)
    parser.add_argument("--model-cache", required=True)
    return parser.parse_args()

def whisper_language(language):
    return {"auto": None, "en": "en", "el": "el", "grc": "el"}[language]

def qwen_language(language):
    return {"auto": None, "en": "English", "el": "Greek", "grc": "Greek"}[language]

def omni_language(language):
    return {"auto": None, "en": "eng_Latn", "el": "ell_Grek", "grc": "grc_Grek"}[language]

def faster_whisper(args, manifest):
    from faster_whisper import WhisperModel
    model = WhisperModel(args.model, device="cpu", compute_type="default",
        download_root=str(Path(args.model_cache) / "faster-whisper"))
    source = manifest[0]
    segments, _ = model.transcribe(source["filename"],
        language=whisper_language(args.language), multilingual=args.language == "auto",
        beam_size=5, vad_filter=True, word_timestamps=True,
        condition_on_previous_text=False, log_progress=True)
    return [{"start": float(segment.start), "end": float(segment.end), "text": segment.text}
            for segment in segments]

def qwen3_asr(args, manifest):
    import torch
    from qwen_asr import Qwen3ASRModel
    if torch.cuda.is_available():
        device, dtype = "cuda:0", torch.bfloat16
    elif getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        device, dtype = "mps", torch.float16
    else:
        device, dtype = "cpu", torch.float32
    model = Qwen3ASRModel.from_pretrained(args.model, dtype=dtype, device_map=device,
        max_inference_batch_size=1, max_new_tokens=1024,
        cache_dir=str(Path(args.model_cache) / "qwen3-asr"))
    output = []
    for index, chunk in enumerate(manifest, 1):
        print(f"[qwen3-asr] chunk {index}/{len(manifest)}", flush=True)
        result = model.transcribe(audio=chunk["filename"], language=qwen_language(args.language))[0]
        output.append({"start": chunk["start"], "end": chunk["end"], "text": result.text})
    return output

def omnilingual_asr(args, manifest):
    from omnilingual_asr.models.inference.pipeline import ASRInferencePipeline
    pipeline = ASRInferencePipeline(model_card=args.model)
    language = omni_language(args.language)
    output = []
    for index, chunk in enumerate(manifest, 1):
        print(f"[omnilingual-asr] chunk {index}/{len(manifest)}", flush=True)
        keyword = {"lang": [language]} if language else {}
        text = pipeline.transcribe([chunk["filename"]], batch_size=1, **keyword)[0]
        output.append({"start": chunk["start"], "end": chunk["end"], "text": str(text)})
    return output

def main():
    args = arguments()
    os.makedirs(args.model_cache, exist_ok=True)
    with open(args.manifest, encoding="utf-8") as stream:
        manifest = json.load(stream)
    handlers = {"faster-whisper": faster_whisper, "qwen3-asr": qwen3_asr,
                "omnilingual-asr": omnilingual_asr}
    segments = handlers[args.backend](args, manifest)
    temporary = f"{args.result}.{os.getpid()}.tmp"
    with open(temporary, "w", encoding="utf-8") as stream:
        json.dump({"segments": segments}, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
    os.replace(temporary, args.result)

if __name__ == "__main__":
    main()
`;
