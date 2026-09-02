/*
  Copyright (C) 2026  NEC2++ contributors

  This program is free software; you can redistribute it and/or modify
  it under the terms of the GNU General Public License as published by
  the Free Software Foundation; either version 2 of the License, or
  (at your option) any later version.
*/
#pragma once

#include "nec_prepared_current_quadrature.h"

/*! Isolated-element characterization request and owned result.
 *
 * Include `nec_stateful_model.h`. That header includes this file after
 * `nec_far_field_grid`, `nec_impedance_result`, and
 * `nec_embedded_far_field_result` are defined.
 */
struct nec_isolated_element_request {
  nec_prepared_quadrature_request quadrature;
  nec_far_field_grid grid;
};

struct nec_isolated_element_characterization {
  nec_impedance_result matrices;
  nec_prepared_current_quadrature quadrature;
  nec_embedded_far_field_result embedded_field;
};
