/*
  Copyright (C) 2026  NEC2++ contributors

  This program is free software; you can redistribute it and/or modify
  it under the terms of the GNU General Public License as published by
  the Free Software Foundation; either version 2 of the License, or
  (at your option) any later version.
*/
#pragma once

#include "common.h"

/*! Immutable-by-value snapshot of NEC's latest simultaneous power balance. */
struct nec_power_budget {
  nec_float input_power_w = 0.0;
  nec_float radiated_power_w = 0.0;
  nec_float structure_loss_w = 0.0;
  nec_float network_loss_w = 0.0;
};
