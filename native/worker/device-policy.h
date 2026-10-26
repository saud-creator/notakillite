#pragma once

#include <cstdint>
#include <limits>
#include <vector>

namespace notakillite {

enum class GpuType { integrated, dedicated };

struct GpuCandidate {
    int ordinal;
    GpuType type;
    std::uint64_t free_bytes;
    std::uint64_t total_bytes;
};

constexpr std::uint64_t gpu_memory_reserve(std::uint64_t device_total_bytes) noexcept {
    constexpr std::uint64_t mib = 1024ULL * 1024ULL;
    constexpr std::uint64_t minimum_reserve = 256ULL * mib;
    const auto reserve_tenths = device_total_bytes / 10 + (device_total_bytes % 10 != 0 ? 1 : 0);
    return reserve_tenths > minimum_reserve ? reserve_tenths : minimum_reserve;
}

constexpr std::uint64_t saturating_add(std::uint64_t left, std::uint64_t right) noexcept {
    const auto maximum = std::numeric_limits<std::uint64_t>::max();
    return right > maximum - left ? maximum : left + right;
}

constexpr std::uint64_t saturating_multiply(std::uint64_t value, std::uint64_t factor) noexcept {
    const auto maximum = std::numeric_limits<std::uint64_t>::max();
    return factor != 0 && value > maximum / factor ? maximum : value * factor;
}

constexpr std::uint64_t conservative_gpu_memory_hint(std::uint64_t model_bytes, std::uint64_t device_total_bytes) noexcept {
    constexpr std::uint64_t mib = 1024ULL * 1024ULL;
    constexpr std::uint64_t fixed_overhead = 512ULL * mib;
    return saturating_add(saturating_add(saturating_multiply(model_bytes, 2), fixed_overhead), gpu_memory_reserve(device_total_bytes));
}

constexpr bool gpu_memory_hint_fits(std::uint64_t free_bytes, std::uint64_t model_bytes, std::uint64_t device_total_bytes) noexcept {
    constexpr std::uint64_t mib = 1024ULL * 1024ULL;
    constexpr std::uint64_t fixed_overhead = 512ULL * mib;
    const auto maximum = std::numeric_limits<std::uint64_t>::max();
    if (model_bytes > maximum / 2) return false;
    auto required = model_bytes * 2;
    if (fixed_overhead > maximum - required) return false;
    required += fixed_overhead;
    const auto reserve = gpu_memory_reserve(device_total_bytes);
    if (reserve > maximum - required) return false;
    required += reserve;
    return free_bytes >= required;
}

// Memory is only a selection hint. If no dedicated device appears to fit,
// keep an integrated device when available, otherwise keep the first GPU.
inline int select_gpu_ordinal(const std::vector<GpuCandidate>& candidates, std::uint64_t model_bytes) noexcept {
    const GpuCandidate* first_available = nullptr;
    const GpuCandidate* first_integrated = nullptr;
    const GpuCandidate* best_fitting_dedicated = nullptr;

    for (const auto& candidate : candidates) {
        if (candidate.ordinal < 0) continue;
        if (first_available == nullptr) first_available = &candidate;
        if (candidate.type == GpuType::integrated && first_integrated == nullptr) first_integrated = &candidate;
        if (candidate.type != GpuType::dedicated) continue;
        if (gpu_memory_hint_fits(candidate.free_bytes, model_bytes, candidate.total_bytes) &&
            (best_fitting_dedicated == nullptr || candidate.free_bytes > best_fitting_dedicated->free_bytes)) {
            best_fitting_dedicated = &candidate;
        }
    }

    if (best_fitting_dedicated != nullptr) return best_fitting_dedicated->ordinal;
    if (first_integrated != nullptr) return first_integrated->ordinal;
    return first_available != nullptr ? first_available->ordinal : -1;
}

} // namespace notakillite
