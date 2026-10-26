// Local JSON-line inference worker. Uses the pinned upstream whisper.cpp API unchanged.
#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#endif
#include "whisper.h"
#include "ggml-backend.h"
#include "json.hpp"
#include "device-policy.h"
#include <algorithm>
#include <chrono>
#include <cstdint>
#include <fstream>
#include <filesystem>
#ifdef _WIN32
#include <windows.h>
#include <psapi.h>
#else
#include <sys/resource.h>
#endif
#include <iostream>
#include <string>
#include <system_error>
#include <vector>
using json = nlohmann::json;
static bool offloaded = false;
static std::string selected_backend;
static uint64_t peak_rss() {
#ifdef _WIN32
    PROCESS_MEMORY_COUNTERS counters; if(GetProcessMemoryInfo(GetCurrentProcess(),&counters,sizeof(counters))) return counters.PeakWorkingSetSize;
#else
    struct rusage usage; if(getrusage(RUSAGE_SELF,&usage)==0) return uint64_t(usage.ru_maxrss)*1024;
#endif
    return 0;
}
static void logger(enum ggml_log_level, const char * text, void *) {
    std::string line(text);
    if (line.find("using CUDA") != std::string::npos || line.find("using Vulkan") != std::string::npos) {
        offloaded = true;
        const auto from = line.find("using "), to = line.find(" backend", from);
        if (from != std::string::npos && to != std::string::npos) selected_backend = line.substr(from + 6, to - from - 6);
    }
    const auto failed = line.find("failed to initialize ");
    if (failed != std::string::npos) {
        const auto from = failed + std::string("failed to initialize ").size();
        const auto to = line.find(" backend", from);
        if (to != std::string::npos) {
            const auto failed_backend = line.substr(from, to - from);
            if (selected_backend.empty() || selected_backend == failed_backend) {
                offloaded = false;
                selected_backend.clear();
            }
        }
    }
    std::cerr << text;
}
static int preferred_gpu_ordinal(const std::string &model_path) {
    std::error_code error;
    const auto file_bytes = std::filesystem::file_size(std::filesystem::u8path(model_path), error);
    const std::uint64_t model_bytes = error ? 0 : static_cast<std::uint64_t>(file_bytes);
    std::vector<notakillite::GpuCandidate> candidates;
    int ordinal = 0;
    for (size_t i = 0; i < ggml_backend_dev_count(); i++) {
        auto device = ggml_backend_dev_get(i);
        const auto type = ggml_backend_dev_type(device);
        if (type != GGML_BACKEND_DEVICE_TYPE_GPU && type != GGML_BACKEND_DEVICE_TYPE_IGPU) continue;
        size_t free_bytes = 0, total_bytes = 0;
        ggml_backend_dev_memory(device, &free_bytes, &total_bytes);
        candidates.push_back({ordinal++, type == GGML_BACKEND_DEVICE_TYPE_GPU ? notakillite::GpuType::dedicated : notakillite::GpuType::integrated,
            static_cast<std::uint64_t>(free_bytes), static_cast<std::uint64_t>(total_bytes)});
    }
    return notakillite::select_gpu_ordinal(candidates, model_bytes);
}
static std::string device_description() {
    for (size_t i = 0; i < ggml_backend_dev_count(); i++) {
        auto device = ggml_backend_dev_get(i);
        if ((offloaded && selected_backend == ggml_backend_dev_name(device)) ||
            (!offloaded && ggml_backend_dev_type(device) == GGML_BACKEND_DEVICE_TYPE_CPU))
            return ggml_backend_dev_description(device);
    }
    return "Unknown";
}
static uint32_t u32(const unsigned char *p) { return uint32_t(p[0]) | uint32_t(p[1]) << 8 | uint32_t(p[2]) << 16 | uint32_t(p[3]) << 24; }
static std::vector<float> wav(const std::string &name) {
    std::ifstream in(std::filesystem::u8path(name), std::ios::binary); unsigned char h[12]; in.read((char*)h,12);
    if (!in || std::string((char*)h,4) != "RIFF" || std::string((char*)h+8,4) != "WAVE") throw std::runtime_error("Expected PCM WAV");
    bool valid = false;
    while(in) {
        unsigned char c[8]; in.read((char*)c,8); if(!in) break; auto size=u32(c+4); std::string id((char*)c,4);
        if(id=="fmt ") { std::vector<unsigned char> f(size); if(size<16 || size>65536) throw std::runtime_error("Invalid WAV format"); in.read((char*)f.data(),size); valid = f[0]==1 && f[2]==1 && u32(f.data()+4)==16000 && f[14]==16; }
        else if(id=="data") {
            if(!valid || size>16000*2*1800 || size%2) throw std::runtime_error("WAV must be mono PCM16/16kHz, at most 30 minutes");
            std::vector<unsigned char> raw(size); in.read((char*)raw.data(),size); if(!in) throw std::runtime_error("Truncated WAV");
            std::vector<float> out(size/2); for(size_t i=0;i<out.size();i++) out[i]=int16_t(raw[i*2] | uint16_t(raw[i*2+1])<<8)/32768.f; return out;
        } else in.seekg(size,std::ios::cur);
        if(size%2) in.seekg(1,std::ios::cur);
    }
    throw std::runtime_error("No PCM data");
}
static int run(int argc, char **argv) {
    if(argc<2) return 2;
    whisper_log_set(logger,nullptr);
    ggml_backend_load_all();
    auto cp=whisper_context_default_params(); cp.use_gpu= !(argc>2 && std::string(argv[2])=="--cpu");
    if(cp.use_gpu) {
        cp.gpu_device=preferred_gpu_ordinal(argv[1]);
        if(cp.gpu_device<0) cp.use_gpu=false;
    }
    auto *ctx=whisper_init_from_file_with_params(argv[1],cp); if(!ctx) return 3;
    std::string line;
    while(std::getline(std::cin,line)) {
        json request; try {
            request=json::parse(line); const auto id=request.at("id");
            if(request.value("type", "transcribe")=="tokenize") {
                auto text=request.value("text", ""); int count=whisper_tokenize(ctx,text.c_str(),nullptr,0); if(count<0) count=-count;
                std::cout<<json({{"id",id},{"result",{{"tokens",count}}}}).dump()<<std::endl; continue;
            }
            auto started=std::chrono::steady_clock::now();
            auto samples=wav(request.at("file").get<std::string>());
            auto p=whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
            auto language=request.value("language", "auto"), prompt=request.value("prompt", "");
            const bool useVad=request.value("vad", false);
            auto vadModelPath=request.value("vadModelPath", std::string());
            p.language=language.c_str(); p.n_threads=std::max(1,request.value("threads",1)); p.no_context=true;
            p.vad=useVad;
            if(useVad) {
                if(vadModelPath.empty()) throw std::runtime_error("VAD model path is required when voice detection is enabled");
                p.vad_model_path=vadModelPath.c_str();
                p.vad_params.min_silence_duration_ms=500;
                p.vad_params.speech_pad_ms=200;
            }
            p.print_progress=false; p.print_realtime=false; p.print_timestamps=false; p.print_special=false; p.suppress_nst=true;
            std::vector<whisper_token> prefix(96);
            int count=prompt.empty()?0:whisper_tokenize(ctx,prompt.c_str(),prefix.data(),(int)prefix.size());
            if(count<0 || count>96) throw std::runtime_error("Vocabulary exceeds 96 model tokens");
            p.prompt_tokens=count?prefix.data():nullptr; p.prompt_n_tokens=count; p.n_max_text_ctx=count;
            if(whisper_full(ctx,p,samples.data(),(int)samples.size())) throw std::runtime_error("Inference failed");
            json segments=json::array();
            for(int i=0;i<whisper_full_n_segments(ctx);i++) segments.push_back({{"start",whisper_full_get_segment_t0(ctx,i)/100.0},{"end",whisper_full_get_segment_t1(ctx,i)/100.0},{"text",whisper_full_get_segment_text(ctx,i)}});
            std::cout<<json({{"id",id},{"result",{{"segments",segments},{"language",whisper_lang_str(whisper_full_lang_id(ctx))},{"device",offloaded?"GPU":"CPU"},{"backendName",offloaded?selected_backend:"CPU"},{"deviceName",device_description()},{"promptTokens",count},{"vadApplied",p.vad},{"vadSegments",p.vad?whisper_full_n_vad_segments(ctx):0},{"nativeMetrics",{{"workerPeakRssBytes",peak_rss()},{"inferenceMs",std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now()-started).count()}}}}}}).dump()<<std::endl;
        } catch(const std::exception &e) { std::cout<<json({{"id",request.value("id",0)},{"error",e.what()}}).dump()<<std::endl; }
    }
    whisper_free(ctx); return 0;
}

#ifdef _WIN32
int wmain(int argc, wchar_t **argv) {
    std::vector<std::string> values; std::vector<char*> args;
    for(int i=0;i<argc;i++) { int n=WideCharToMultiByte(CP_UTF8,0,argv[i],-1,nullptr,0,nullptr,nullptr); std::string value(n,'\0'); WideCharToMultiByte(CP_UTF8,0,argv[i],-1,value.data(),n,nullptr,nullptr); values.push_back(value); }
    for(auto &value:values) args.push_back(value.data()); return run(argc,args.data());
}
#else
int main(int argc,char **argv) { return run(argc,argv); }
#endif
