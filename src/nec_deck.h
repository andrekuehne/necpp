#pragma once

#include "nec_exception.h"

#include <iosfwd>
#include <string>

class nec_context;
class nec_output_file;

/* Invalid text/card input, distinct from a failure while executing a solve. */
class nec_deck_input_exception : public nec_exception
{
public:
    explicit nec_deck_input_exception(const char* message)
        : nec_exception(message)
    {
    }
};

/* Process one or more complete NEC jobs supplied as text. */
void nec_process_deck(const std::string& input_text,
                      nec_context& context,
                      nec_output_file& output);
