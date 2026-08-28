#include "nec_deck.h"

#include "c_geometry.h"
#include "misc.h"
#include "nec_card_parser.h"
#include "nec_context.h"
#include "nec_exception.h"
#include "nec_output.h"

#include <cstring>
#include <sstream>
#include <string>

namespace {

void print_program_header(nec_output_file& output)
{
    output.end_section();
    output.set_indent(31);
    output.line(" __________________________________________");
    output.line("|                                          |");
    output.line("| NUMERICAL ELECTROMAGNETICS CODE (nec2++) |");
    output.line("| Implemented in 'C++' in Double Precision |");
    output.line("|        Version " nec_version "        |");
    output.line("|__________________________________________|");
}

void read_comments_or_rewind(std::istream& input, nec_output_file& output)
{
    const std::streampos job_start = input.tellg();
    char mnemonic[3] = {0, 0, 0};
    char line[LINE_LEN + 1] = {0};

    if ((load_line(line, input) == EOF) && (line[0] == '\0'))
        throw nec_exception("Error reading input text.");

    std::strncpy(mnemonic, line, 2);
    if ((0 != std::strcmp(mnemonic, "CM")) &&
        (0 != std::strcmp(mnemonic, "CE"))) {
        input.clear();
        input.seekg(job_start);
        if (!input)
            throw nec_exception("Unable to rewind NEC input text.");
        return;
    }

    output.end_section();
    output.set_indent(31);
    output.line("---------------- COMMENTS ----------------");
    output.line(&line[2]);

    while (0 == std::strcmp(mnemonic, "CM")) {
        line[0] = '\0';
        if ((load_line(line, input) == EOF) && (line[0] == '\0'))
            throw nec_exception("Error reading input text (comments not terminated?).");
        std::strncpy(mnemonic, line, 2);
        mnemonic[2] = '\0';
        output.line(&line[2]);
    }

    if (0 != std::strcmp(mnemonic, "CE"))
        throw nec_exception("ERROR: INCORRECT LABEL FOR A COMMENT CARD");
}

nec_card read_control_card(std::istream& input)
{
    char line[LINE_LEN + 1] = {0};
    const int eof = load_line(line, input);
    const size_t length = std::strlen(line);

    if (length < 2) {
        if (EOF == eof) {
            nec_card end;
            end.mnemonic = "EN";
            return end;
        }
        throw nec_exception(
            "COMMAND DATA CARD ERROR: CARD'S MNEMONIC CODE TOO SHORT OR MISSING.");
    }

    nec_card card = parse_nec_card(line);
    if (card.mnemonic == "XT")
        throw nec_exception("XT is not supported by the string API.");
    return card;
}

void print_control_card(nec_output_file& output, int count, const nec_card& card)
{
    output.nec_printf(
        "\n*****  DATA CARD N0. %3d %s %3d %5d %5d %5d"
        " %12.5E %12.5E %12.5E %12.5E %12.5E %12.5E",
        count, card.mnemonic.c_str(),
        card.i[0], card.i[1], card.i[2], card.i[3],
        card.f[0], card.f[1], card.f[2],
        card.f[3], card.f[4], card.f[5]);
}

} // namespace

void nec_process_deck(const std::string& input_text,
                      nec_context& context,
                      nec_output_file& output)
{
    if (input_text.empty())
        throw nec_exception("NEC input text is empty.");

    std::istringstream input(input_text);
    nec_output_flags output_flags;
    context.set_output(output, output_flags);
    context.initialize();

    while (true) {
        print_program_header(output);
        read_comments_or_rewind(input, output);

        context.get_geometry()->parse_geometry(&context, input);
        context.calc_prepare();
        output.end_section();

        int data_card_count = 0;
        while (true) {
            nec_card card = read_control_card(input);
            print_control_card(output, ++data_card_count, card);

            if (card.mnemonic == "NX")
                break;
            if (card.mnemonic == "EN") {
                context.all_jobs_completed();
                return;
            }
            if (card.mnemonic == "PL")
                throw nec_exception("PL is not supported by the string API.");

            const card_handler* handler = find_handler(card.mnemonic);
            if (nullptr == handler)
                throw nec_exception("FAULTY DATA CARD LABEL AFTER GEOMETRY SECTION.");
            handler->dispatch(context, card);
        }
    }
}

/* Table-driven control-card handlers shared by the CLI and string API. */
void handle_fr(nec_context& ctx, const nec_card& c) {
    ctx.fr_card(c.i[0], c.i[1], c.f[0], c.f[1]);
}
void handle_ld(nec_context& ctx, const nec_card& c) {
    ctx.ld_card(c.i[0], c.i[1], c.i[2], c.i[3], c.f[0], c.f[1], c.f[2]);
}
void handle_gn(nec_context& ctx, const nec_card& c) {
    ctx.gn_card(c.i[0], c.i[1], c.f[0], c.f[1], c.f[2], c.f[3], c.f[4], c.f[5]);
}
void handle_ex(nec_context& ctx, const nec_card& c) {
    ctx.ex_card(static_cast<excitation_type>(c.i[0]), c.i[1], c.i[2], c.i[3],
                c.f[0], c.f[1], c.f[2], c.f[3], c.f[4], c.f[5]);
}
void handle_nt(nec_context& ctx, const nec_card& c) {
    ctx.nt_card(c.i[0], c.i[1], c.i[2], c.i[3],
                c.f[0], c.f[1], c.f[2], c.f[3], c.f[4], c.f[5]);
}
void handle_tl(nec_context& ctx, const nec_card& c) {
    ctx.tl_card(c.i[0], c.i[1], c.i[2], c.i[3],
                c.f[0], c.f[1], c.f[2], c.f[3], c.f[4], c.f[5]);
}
void handle_xq(nec_context& ctx, const nec_card& c) { ctx.xq_card(c.i[0]); }
void handle_gd(nec_context& ctx, const nec_card& c) {
    ctx.gd_card(c.f[0], c.f[1], c.f[2], c.f[3]);
}
void handle_rp(nec_context& ctx, const nec_card& c) {
    const int xnda = c.i[3];
    ctx.rp_card(c.i[0], c.i[1], c.i[2],
                xnda / 1000, (xnda / 100) % 10, (xnda / 10) % 10, xnda % 10,
                c.f[0], c.f[1], c.f[2], c.f[3], c.f[4], c.f[5]);
}
void handle_nx(nec_context&, const nec_card&) {}
void handle_pt(nec_context& ctx, const nec_card& c) {
    ctx.pt_card(c.i[0], c.i[1], c.i[2], c.i[3]);
}
void handle_kh(nec_context& ctx, const nec_card& c) { ctx.kh_card(c.f[0]); }
void handle_ne(nec_context& ctx, const nec_card& c) {
    ctx.ne_card(c.i[0], c.i[1], c.i[2], c.i[3],
                c.f[0], c.f[1], c.f[2], c.f[3], c.f[4], c.f[5]);
}
void handle_nh(nec_context& ctx, const nec_card& c) {
    ctx.nh_card(c.i[0], c.i[1], c.i[2], c.i[3],
                c.f[0], c.f[1], c.f[2], c.f[3], c.f[4], c.f[5]);
}
void handle_pq(nec_context& ctx, const nec_card& c) {
    ctx.pq_card(c.i[0], c.i[1], c.i[2], c.i[3]);
}
void handle_ek(nec_context& ctx, const nec_card& c) {
    ctx.set_extended_thin_wire_kernel(c.i[0] != -1);
}
void handle_cp(nec_context& ctx, const nec_card& c) {
    ctx.cp_card(c.i[0], c.i[1], c.i[2], c.i[3]);
}
void handle_pl(nec_context&, const nec_card&) {}
void handle_en(nec_context& ctx, const nec_card&) { ctx.all_jobs_completed(); }
void handle_wg(nec_context&, const nec_card&) {
    throw nec_exception("\"WG\" card, not supported.");
}
void handle_mp(nec_context& ctx, const nec_card& c) {
    ctx.medium_parameters(c.f[0], c.f[1]);
}
