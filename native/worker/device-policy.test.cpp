#include "device-policy.h"

#include <array>
#include <cstdint>
#include <iostream>
#include <limits>
#include <string>
#include <vector>

using notakillite::GpuCandidate;
using notakillite::GpuType;
using notakillite::select_gpu_ordinal;

struct PolicyCase {
    const char* name;
    std::vector<GpuCandidate> devices;
    std::uint64_t model_bytes;
    int expected_ordinal;
};

int main() {
    constexpr std::uint64_t mib = 1024ULL * 1024ULL;
    constexpr std::uint64_t gib = 1024ULL * 1024ULL * 1024ULL;
    const std::array<PolicyCase, 5> cases{{
        {"fitting dedicated GPU beats earlier integrated GPU and ranks by free memory",
            {{0, GpuType::integrated, 8 * gib, 16 * gib}, {1, GpuType::dedicated, 8 * gib, 12 * gib}, {2, GpuType::dedicated, 9 * gib, 16 * gib}}, 2 * gib, 2},
        {"underbudget dedicated GPU falls back to integrated GPU",
            {{1, GpuType::dedicated, 2 * gib, 8 * gib}, {0, GpuType::integrated, 1 * gib, 4 * gib}}, 2 * gib, 0},
        {"uncertain sole dedicated GPU is retained as a hint-only fallback",
            {{1, GpuType::dedicated, 0, 0}}, 4 * gib, 1},
        {"no GPU selects CPU",
            {}, 2 * gib, -1},
        {"overflowing model estimate cannot make an underbudget dedicated GPU appear to fit",
            {{1, GpuType::dedicated, std::numeric_limits<std::uint64_t>::max(), 8 * gib}, {0, GpuType::integrated, 0, 0}}, std::numeric_limits<std::uint64_t>::max() / 2 + 1, 0},
    }};

    for (const auto& test : cases) {
        const auto actual = select_gpu_ordinal(test.devices, test.model_bytes);
        if (actual != test.expected_ordinal) {
            std::cerr << "FAIL: " << test.name << " (expected " << test.expected_ordinal << ", got " << actual << ")\n";
            return 1;
        }
        std::cout << "PASS: " << test.name << '\n';
    }

    const auto exact_requirement = notakillite::conservative_gpu_memory_hint(2 * gib, 16 * gib);
    if (exact_requirement != 4 * gib + 512 * mib + (16 * gib / 10 + 1)) {
        std::cerr << "FAIL: memory hint should include model x2, 512 MiB overhead and a 10% reserve\n";
        return 1;
    }
    std::cout << "PASS: conservative memory hint formula\n";
    return 0;
}
