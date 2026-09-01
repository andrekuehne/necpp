#####################################################################################
#
#   Library, executables, install/export for nec2++.
#
#####################################################################################

# --- The canonical nec2++ source list. -------------------------------------
# Single source of truth: every target below (static lib, shared lib, tests,
# WASM) is built from this one list. Add/remove a .cpp here and it propagates
# everywhere.
set(NECPP_LIB_SRCS
    c_evlcom.cpp
    c_geometry.cpp
    c_ggrid.cpp
    c_plot_card.cpp
    electromag.cpp
    libNEC.cpp
    matrix_algebra.cpp
    misc.cpp
    nec_deck.cpp
    nec_context.cpp
    nec_exception.cpp
    nec_far_field.cpp
    nec_ground.cpp
    nec_output.cpp
    nec_port_matrix.cpp
    nec_radiation_pattern.cpp
    nec_results.cpp
    nec_stateful_model.cpp
    nec_structure_currents.cpp
    necpp_wasm_v1.cpp
)

# WP2A-only experiment: relaxed floating-point transformations are scoped to
# the far-field translation unit and are never part of the default build.
if(NECPP_FAR_FIELD_OPTIMIZATIONS STREQUAL "ACCUM4_RELAXED")
    if(MSVC)
        set_source_files_properties(nec_far_field.cpp PROPERTIES
            COMPILE_OPTIONS "/fp:fast")
    else()
        set_source_files_properties(nec_far_field.cpp PROPERTIES
            COMPILE_OPTIONS "-ffast-math")
    endif()
endif()

# Public-facing headers installed alongside the library.
set(NECPP_PUBLIC_HEADERS
    libnecpp.h
    nec_context.h
    c_geometry.h
    nec_ground.h
    nec_geometry_symmetry.h
    nec_radiation_pattern.h
    nec_results.h
    nec_stateful_model.h
    nec_structure_currents.h
    necpp_wasm_v1.h
    nec_output.h
    nec_power_budget.h
    nec_exception.h
    c_evlcom.h
    c_ggrid.h
    c_plot_card.h
    electromag.h
    matrix_algebra.h
    misc.h
    nec_wire.h
    math_util.h
    safe_array.h
    common.h
    typesafe_stdint.h
    nec_debug.h
    nec_card_parser.h
    AntennaInput.h
    BaseInput.h
    CurrentInput.h
    PowerBudget.h
    RadiationInput.h
    nec2cpp.h
    XGetopt.h
)

# --- OBJECT library: compiled once, linked into both static and shared. ----
add_library(necpp_obj OBJECT ${NECPP_LIB_SRCS})
if(NECPP_ENABLE_PERFORMANCE_DIAGNOSTICS)
    target_compile_definitions(necpp_obj PRIVATE NECPP_ENABLE_PERFORMANCE_DIAGNOSTICS=1)
endif()
target_include_directories(necpp_obj
    PUBLIC
        ${CMAKE_CURRENT_SOURCE_DIR}
        ${NECPP_EIGEN_DIR}
        ${CMAKE_BINARY_DIR})        # for generated config.h
# Warning flags. The old Makefile used -Wall -Wextra -Wshadow (GCC/Clang).
# MSVC uses /W3 or /W4 instead; enable /W3 as a reasonable baseline.
if(MSVC)
    target_compile_options(necpp_obj PRIVATE /W3)
else()
    target_compile_options(necpp_obj PRIVATE -Wall -Wextra -Wshadow)
endif()

# --- Static library --------------------------------------------------------
add_library(necpp_static STATIC $<TARGET_OBJECTS:necpp_obj>)
set_target_properties(necpp_static PROPERTIES
    OUTPUT_NAME necpp
    EXPORT_NAME necpp_static
    POSITION_INDEPENDENT_CODE ON)
target_include_directories(necpp_static
    PUBLIC
        $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}>
        $<BUILD_INTERFACE:${NECPP_EIGEN_DIR}>
        $<BUILD_INTERFACE:${CMAKE_BINARY_DIR}>
        $<INSTALL_INTERFACE:include/necpp>)
# On Linux, link the math library.
target_link_libraries(necpp_static PUBLIC ${CMAKE_DL_LIBS})
if(UNIX AND NOT APPLE)
    target_link_libraries(necpp_static PUBLIC m)
endif()

# --- Shared library (optional) ---------------------------------------------
if(BUILD_SHARED_LIBS)
    add_library(necpp_shared SHARED $<TARGET_OBJECTS:necpp_obj>)
    set_target_properties(necpp_shared PROPERTIES
        OUTPUT_NAME necpp
        EXPORT_NAME necpp
        SOVERSION ${PROJECT_VERSION_MAJOR}
        VERSION ${PROJECT_VERSION})
    target_include_directories(necpp_shared
        PUBLIC
            $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}>
            $<BUILD_INTERFACE:${NECPP_EIGEN_DIR}>
            $<BUILD_INTERFACE:${CMAKE_BINARY_DIR}>
            $<INSTALL_INTERFACE:include/necpp>)
    target_link_libraries(necpp_shared PUBLIC ${CMAKE_DL_LIBS})
    if(UNIX AND NOT APPLE)
        target_link_libraries(necpp_shared PUBLIC m)
    endif()
    add_library(necpp::necpp ALIAS necpp_shared)
    # Default library target consumed by executables: prefer the shared lib
    # when it exists, otherwise the static one.
    set(NECPP_LIB_TARGET necpp_shared)
else()
    # Static-only build: export the static target as the canonical necpp::necpp
    # so downstream find_package(necpp) users get one stable name either way.
    set_target_properties(necpp_static PROPERTIES EXPORT_NAME necpp)
    add_library(necpp::necpp ALIAS necpp_static)
    set(NECPP_LIB_TARGET necpp_static)
endif()

# --- Command-line executables ----------------------------------------------
# nec2++ — the main NEC-2 simulation driver.
add_executable(nec2++ nec2cpp.cpp XGetopt.cpp)
target_link_libraries(nec2++ PRIVATE ${NECPP_LIB_TARGET})
set_target_properties(nec2++ PROPERTIES OUTPUT_NAME "nec2++")

# nec2diff — utility for diffing two NEC output files.
add_executable(nec2diff necDiff.cpp)
target_link_libraries(nec2diff PRIVATE ${NECPP_LIB_TARGET})

# Under a WASM build we only want the Emscripten artifacts; skip the native
# executables so `cmake --build` doesn't waste time compiling nec2++/nec2diff
# as (broken) .js shells.
if(NECPP_BUILD_WASM)
    set_target_properties(nec2++ nec2diff PROPERTIES EXCLUDE_FROM_ALL ON)
endif()

# --- WASM target (opt-in via -DNECPP_BUILD_WASM=ON, needs emcc) ------------
if(NECPP_BUILD_WASM)
    add_executable(nec2pp_wasm
        ${NECPP_LIB_SRCS}
        nec_field_evaluator_wasm.cpp)
    target_include_directories(nec2pp_wasm PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}
        ${NECPP_EIGEN_DIR}
        ${CMAKE_BINARY_DIR})
    if(NECPP_ENABLE_PERFORMANCE_DIAGNOSTICS)
        target_compile_definitions(nec2pp_wasm PRIVATE NECPP_ENABLE_PERFORMANCE_DIAGNOSTICS=1)
    endif()
    # Exceptions must be enabled while compiling every source in the target and
    # while linking the Emscripten module so the C ABI can contain failures.
    target_compile_options(nec2pp_wasm PRIVATE -fexceptions)
    target_link_options(nec2pp_wasm PRIVATE
        -fexceptions
        -sWASM=1
        "-sEXPORTED_FUNCTIONS=[\"_malloc\",\"_free\",\"_necpp_field_evaluator_v1_version\",\"_necpp_field_evaluator_v1_evaluate\",\"_necpp_wasm_v1_abi_version\",\"_necpp_wasm_v1_engine_version\",\"_necpp_wasm_v1_model_create\",\"_necpp_wasm_v1_model_delete\",\"_necpp_wasm_v1_model_state\",\"_necpp_wasm_v1_last_status\",\"_necpp_wasm_v1_last_error\",\"_necpp_wasm_v1_add_wire\",\"_necpp_wasm_v1_complete_geometry\",\"_necpp_wasm_v1_complete_geometry_symmetric\",\"_necpp_wasm_v1_define_ports\",\"_necpp_wasm_v1_add_load\",\"_necpp_wasm_v1_clear_loads\",\"_necpp_wasm_v1_set_ground\",\"_necpp_wasm_v1_prepare\",\"_necpp_wasm_v1_compute_impedance\",\"_necpp_wasm_v1_solve_voltages\",\"_necpp_wasm_v1_solve_currents\",\"_necpp_wasm_v1_compute_far_field\",\"_necpp_wasm_v1_compute_embedded_far_fields\",\"_necpp_wasm_v1_capture_far_field_snapshot\",\"_necpp_wasm_v1_far_field_snapshot_capability\",\"_necpp_wasm_v1_far_field_snapshot_schema_version\",\"_necpp_wasm_v1_far_field_snapshot_segment_count\",\"_necpp_wasm_v1_far_field_snapshot_frequency_mhz\",\"_necpp_wasm_v1_far_field_snapshot_wavelength_m\",\"_necpp_wasm_v1_far_field_snapshot_model_generation\",\"_necpp_wasm_v1_far_field_snapshot_solution_generation\",\"_necpp_wasm_v1_far_field_snapshot_perfect_ground\",\"_necpp_wasm_v1_port_count\",\"_necpp_wasm_v1_port_tags\",\"_necpp_wasm_v1_port_segments\",\"_necpp_wasm_v1_geometry_symmetry_kind\",\"_necpp_wasm_v1_geometry_section_count\",\"_necpp_wasm_v1_geometry_fundamental_segment_count\",\"_necpp_wasm_v1_geometry_full_segment_count\",\"_necpp_wasm_v1_impedance_order\",\"_necpp_wasm_v1_impedance_frequency_mhz\",\"_necpp_wasm_v1_impedance_condition_estimate\",\"_necpp_wasm_v1_impedance_factorization_generation\",\"_necpp_wasm_v1_solution_count\",\"_necpp_wasm_v1_solution_drive\",\"_necpp_wasm_v1_solution_frequency_mhz\",\"_necpp_wasm_v1_solution_factorization_generation\",\"_necpp_wasm_v1_solution_generation\",\"_necpp_wasm_v1_solution_input_power_w\",\"_necpp_wasm_v1_solution_radiated_power_w\",\"_necpp_wasm_v1_solution_structure_loss_w\",\"_necpp_wasm_v1_solution_network_loss_w\",\"_necpp_wasm_v1_far_field_radius_m\",\"_necpp_wasm_v1_far_field_frequency_mhz\",\"_necpp_wasm_v1_far_field_theta_count\",\"_necpp_wasm_v1_far_field_phi_count\",\"_necpp_wasm_v1_far_field_diagnostic\",\"_necpp_wasm_v1_embedded_radius_m\",\"_necpp_wasm_v1_embedded_frequency_mhz\",\"_necpp_wasm_v1_embedded_theta_count\",\"_necpp_wasm_v1_embedded_phi_count\",\"_necpp_wasm_v1_embedded_port_count\",\"_necpp_wasm_v1_embedded_samples_per_port\",\"_necpp_wasm_v1_embedded_normalization\",\"_necpp_wasm_v1_result_buffer\",\"_necpp_wasm_v1_result_buffer_length\",\"_necpp_wasm_v1_deck_create\",\"_necpp_wasm_v1_deck_delete\",\"_necpp_wasm_v1_deck_process\",\"_necpp_wasm_v1_deck_last_status\",\"_necpp_wasm_v1_deck_last_error\",\"_necpp_wasm_v1_deck_output\",\"_necpp_wasm_v1_deck_output_length\"]"
        -sDISABLE_EXCEPTION_CATCHING=0
        -sALLOW_MEMORY_GROWTH=1
        "-sSTACK_SIZE=${NECPP_WASM_STACK_SIZE}"
        --no-entry)
    # OUTPUT_NAME nec2pp + SUFFIX .js → Emscripten emits nec2pp.js + nec2pp.wasm,
    # matching the legacy Makefile output names.
    set_target_properties(nec2pp_wasm PROPERTIES
        OUTPUT_NAME nec2pp
        PREFIX ""
        SUFFIX ".js")
    # Surface the wasm next to the js (Emscripten emits it in the build dir).
    add_custom_command(TARGET nec2pp_wasm POST_BUILD
        COMMAND ${CMAKE_COMMAND} -E copy_if_different
            ${CMAKE_CURRENT_BINARY_DIR}/nec2pp.wasm
            ${CMAKE_BINARY_DIR}/nec2pp.wasm
        COMMAND ${CMAKE_COMMAND} -E copy_if_different
            ${CMAKE_CURRENT_BINARY_DIR}/nec2pp.js
            ${CMAKE_BINARY_DIR}/nec2pp.js
        COMMENT "Copying WASM artifacts to build root")

    add_executable(necpp_field_evaluator_wasm nec_field_evaluator_wasm.cpp)
    target_compile_options(necpp_field_evaluator_wasm PRIVATE -fno-exceptions)
    target_link_options(necpp_field_evaluator_wasm PRIVATE
        -sWASM=1
        "-sEXPORTED_FUNCTIONS=[\"_malloc\",\"_free\",\"_necpp_field_evaluator_v1_version\",\"_necpp_field_evaluator_v1_evaluate\"]"
        -sALLOW_MEMORY_GROWTH=1
        "-sSTACK_SIZE=65536"
        --no-entry)
    set_target_properties(necpp_field_evaluator_wasm PROPERTIES
        OUTPUT_NAME necpp-field-evaluator
        PREFIX ""
        SUFFIX ".js")
    add_custom_command(TARGET necpp_field_evaluator_wasm POST_BUILD
        COMMAND ${CMAKE_COMMAND} -E copy_if_different
            ${CMAKE_CURRENT_BINARY_DIR}/necpp-field-evaluator.wasm
            ${CMAKE_BINARY_DIR}/necpp-field-evaluator.wasm
        COMMAND ${CMAKE_COMMAND} -E copy_if_different
            ${CMAKE_CURRENT_BINARY_DIR}/necpp-field-evaluator.js
            ${CMAKE_BINARY_DIR}/necpp-field-evaluator.js
        COMMENT "Copying dedicated field-evaluator WASM artifacts")
endif()

# --- Installation ----------------------------------------------------------
include(GNUInstallDirs)

install(TARGETS necpp_static
    EXPORT necppTargets
    COMPONENT Development
    ARCHIVE DESTINATION ${CMAKE_INSTALL_LIBDIR})

if(BUILD_SHARED_LIBS)
    install(TARGETS necpp_shared
        EXPORT necppTargets
        COMPONENT Runtime
        ARCHIVE DESTINATION ${CMAKE_INSTALL_LIBDIR}
        LIBRARY DESTINATION ${CMAKE_INSTALL_LIBDIR}
        RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR})
endif()

install(TARGETS nec2++ nec2diff
    COMPONENT CLI
    RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR})

# Public headers → include/necpp/
install(FILES
    ${NECPP_PUBLIC_HEADERS}
    DESTINATION ${CMAKE_INSTALL_INCLUDEDIR}/necpp
    COMPONENT Development)

# Bundled Eigen headers needed to use the library (it is header-only and
# types from it leak into the public API).
install(DIRECTORY ${NECPP_EIGEN_DIR}/
    DESTINATION ${CMAKE_INSTALL_INCLUDEDIR}/necpp/eigen
    COMPONENT Development
    FILES_MATCHING PATTERN "*.h"
                    PATTERN "*.hpp"
                    PATTERN "CMakeLists.txt" EXCLUDE)

# Man pages (exist in the repo root, were never installed by the old Makefile).
install(FILES
    ${CMAKE_SOURCE_DIR}/nec2++.1
    ${CMAKE_SOURCE_DIR}/nec2diff.1
    DESTINATION ${CMAKE_INSTALL_MANDIR}/man1
    COMPONENT CLI OPTIONAL)

# --- pkg-config file -------------------------------------------------------
# Only Linux needs explicit -lm; macOS includes it in libc, Windows in the CRT.
if(UNIX AND NOT APPLE)
    set(NECPP_PC_MATH_LIB "-lm")
else()
    set(NECPP_PC_MATH_LIB "")
endif()
configure_file(
    ${CMAKE_SOURCE_DIR}/cmake/necpp.pc.in
    ${CMAKE_BINARY_DIR}/necpp.pc
    @ONLY)
install(FILES ${CMAKE_BINARY_DIR}/necpp.pc
    DESTINATION ${CMAKE_INSTALL_LIBDIR}/pkgconfig
    COMPONENT Development)

# --- CMake package config (find_package(necpp)) ----------------------------
include(CMakePackageConfigHelpers)
write_basic_package_version_file(
    ${CMAKE_BINARY_DIR}/necppConfigVersion.cmake
    VERSION ${PROJECT_VERSION}
    COMPATIBILITY SameMajorVersion)
configure_package_config_file(
    ${CMAKE_SOURCE_DIR}/cmake/necppConfig.cmake.in
    ${CMAKE_BINARY_DIR}/necppConfig.cmake
    INSTALL_DESTINATION ${CMAKE_INSTALL_LIBDIR}/cmake/necpp)

install(EXPORT necppTargets
    FILE necppTargets.cmake
    NAMESPACE necpp::
    DESTINATION ${CMAKE_INSTALL_LIBDIR}/cmake/necpp
    COMPONENT Development)

install(FILES
    ${CMAKE_BINARY_DIR}/necppConfig.cmake
    ${CMAKE_BINARY_DIR}/necppConfigVersion.cmake
    DESTINATION ${CMAKE_INSTALL_LIBDIR}/cmake/necpp
    COMPONENT Development)
