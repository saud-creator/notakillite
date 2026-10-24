// C API of DeepFilterNet's libDF (tag v0.5.6, feature "capi"; see libDF/src/capi.rs upstream).
// Built for iOS by ios/ci/build-deepfilter.sh. Audio is 48 kHz mono 32-bit float.
#ifndef DEEP_FILTER_H
#define DEEP_FILTER_H

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/// Opaque DeepFilterNet state: STFT, DNN noise reduction and inverse STFT for one mono stream.
typedef struct DFState DFState;

/// Loads a DeepFilterNet `.tar.gz` ONNX model. `atten_lim` is the attenuation limit in dB
/// (100 = full noise reduction). Aborts the process if the model cannot be read, so check the path first.
DFState *df_create(const char *path, float atten_lim);

/// Samples per frame (hop size; 480 for DeepFilterNet3).
size_t df_get_frame_length(DFState *st);

/// Changes the attenuation limit in dB.
void df_set_atten_lim(DFState *st, float lim_db);

/// Post-filter strength; 0 disables it (the default).
void df_set_post_filter_beta(DFState *st, float beta);

/// Processes one frame of `df_get_frame_length()` samples into `output`. Returns the local SNR in dB.
float df_process_frame(DFState *st, float *input, float *output);

/// Frees a state created by df_create().
void df_free(DFState *model);

#ifdef __cplusplus
}
#endif

#endif
