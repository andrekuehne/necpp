#pragma once

#include <iosfwd>
#include <string>

class nec_context;
class nec_output_file;

/* Process one or more complete NEC jobs supplied as text. */
void nec_process_deck(const std::string& input_text,
                      nec_context& context,
                      nec_output_file& output);
