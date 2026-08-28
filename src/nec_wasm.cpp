/*
 * String-based C ABI for the reusable Emscripten module.
 *
 * The WASM target intentionally has no CLI main(). JavaScript supplies a
 * complete NEC deck to nec_process_input(), then reads the generated report
 * with nec_get_output(). Every exported function contains its exceptions so
 * no C++ exception can cross the C/WASM boundary.
 */

#include "nec_context.h"
#include "nec_deck.h"
#include "nec_exception.h"
#include "nec_output.h"

#include <climits>
#include <exception>
#include <memory>
#include <sstream>
#include <string>

struct nec_wasm_context {
    std::unique_ptr<nec_context> context;
    std::string output_buffer;
    bool has_results = false;
};

namespace {

void store_error(nec_wasm_context* context,
                 const char* prefix,
                 const char* message) noexcept
{
    if (nullptr == context)
        return;

    context->has_results = false;
    try {
        context->output_buffer.assign(prefix ? prefix : "Error: ");
        if (message)
            context->output_buffer.append(message);
    } catch (...) {
        /* An allocation failure while reporting an error must not escape ABI. */
        try {
            context->output_buffer.clear();
        } catch (...) {
        }
    }
}

} // namespace

extern "C" {

nec_wasm_context* nec_create_context(void) noexcept
{
    try {
        return new nec_wasm_context();
    } catch (...) {
        return nullptr;
    }
}

void nec_delete_context(nec_wasm_context* context) noexcept
{
    try {
        delete context;
    } catch (...) {
        /* C++ destructors are not allowed to escape the C ABI. */
    }
}

/*
 * Process a complete NEC input deck supplied as a UTF-8 C string.
 * Returns 0 on success, or a negative error code:
 *   -1 : null context or input
 *   -2 : parse/execution error (message stored in output)
 */
int nec_process_input(nec_wasm_context* context, const char* input_text) noexcept
{
    if ((nullptr == context) || (nullptr == input_text))
        return -1;

    try {
        context->has_results = false;
        context->output_buffer.clear();

        /* Each call gets a fresh solver so a failed deck cannot poison the next. */
        std::unique_ptr<nec_context> solver(new nec_context());
        std::ostringstream report;
        nec_output_file output;
        output.set_stream(report);

        nec_process_deck(input_text, *solver, output);

        context->output_buffer = report.str();
        context->context = std::move(solver);
        context->has_results = true;
        return 0;
    } catch (const nec_exception& error) {
        try {
            const std::string message = error.get_message();
            store_error(context, "Error: ", message.c_str());
        } catch (...) {
            store_error(context, "Error: ", "NEC++ exception");
        }
        return -2;
    } catch (const std::exception& error) {
        store_error(context, "Error: ", error.what());
        return -2;
    } catch (const char* error) {
        store_error(context, "Error: ", error);
        return -2;
    } catch (...) {
        store_error(context, "Error: ", "Unknown exception");
        return -2;
    }
}

/* Returns the output buffer; the caller must not free it. */
const char* nec_get_output(nec_wasm_context* context) noexcept
{
    try {
        return context ? context->output_buffer.c_str() : "";
    } catch (...) {
        return "";
    }
}

int nec_get_output_length(nec_wasm_context* context) noexcept
{
    try {
        if (!context)
            return 0;
        const size_t length = context->output_buffer.size();
        return length > static_cast<size_t>(INT_MAX)
            ? INT_MAX
            : static_cast<int>(length);
    } catch (...) {
        return 0;
    }
}

/* Reserved for a future API returning caller-owned allocations. */
void nec_free(void*) noexcept
{
}

} /* extern "C" */
