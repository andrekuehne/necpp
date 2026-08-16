/*
	Copyright (C) 2004  Timothy C.A. Molteno
	
	This program is free software; you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation; either version 2 of the License, or
	(at your option) any later version.
	
	This program is distributed in the hope that it will be useful,
	but WITHOUT ANY WARRANTY; without even the implied warranty of
	MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
	GNU General Public License for more details.
	
	You should have received a copy of the GNU General Public License
	along with this program; if not, write to the Free Software
	Foundation, Inc., 59 Temple Place, Suite 330, Boston, MA  02111-1307  USA
*/
#pragma once

#include <array>

#include "math_util.h"

void 	bessel(nec_complex z, nec_complex *j0, nec_complex *j0p);
void 	hankel(nec_complex z, nec_complex *h0, nec_complex *h0p);

class c_evlcom
{
public:
	nec_float m_ck2, m_ck2sq, m_tkmag, m_tsmag, m_ck1r, m_zph, m_rho;
	nec_complex m_ct1, m_ct2, m_ct3, m_ck1, m_ck1sq, m_cksm;

	nec_complex m_contour_a, m_contour_b;
	
	/*! \brief Compute integration parameter xlam=lambda from parameter t.
	*/
	void lambda( nec_float t, nec_complex *xlam, nec_complex *dxlam ) const;


	/*! \brief gshank integrates the 6 Sommerfeld integrals from start to 
		infinity (until convergence) in lambda.  At the break point, bk, 
		the step increment may be changed from dela to delb.  Shank's 
		algorithm to accelerate convergence of a slowly converging series
		is used. */
	void gshank( nec_complex start, nec_complex dela, nec_complex* sum,
		int nans, nec_complex* seed, int ibk, nec_complex bk, nec_complex delb );


	/*! \brief rom1 integrates the 6 Sommerfeld integrals from m_contour_a to m_contour_b in lambda.
		The method of variable interval width Romberg integration is used. */
	void rom1( int n, nec_complex* sum, int nx );
	
	/*! \brief saoa computes the integrand for each of the 6 Sommerfeld
		integrals for source and observer above ground. */
	void saoa( nec_float t, std::array<nec_complex,6>& ans);

	/*! \brief evlua controls the integration contour in the complex
		lambda plane for evaluation of the Sommerfeld integrals. */
	void evlua( nec_complex *erv, nec_complex *ezv,
		nec_complex *erh, nec_complex *eph );

	/*! \brief Test support: select the Bessel-function form (true) or the
		Hankel-function form (false) of the integrand used by saoa(). */
	void set_bessel_flag(bool f) { m_bessel_flag = f; }

private:
	/*! \brief Flag to select Bessel or Hankel function form (was jh) */
	bool m_bessel_flag;
};

/* Numerical integration convergence tests (used by Sommerfeld integration) */
void test(nec_float f1r, nec_float f2r, nec_float *tr, nec_float f1i,
  nec_float f2i, nec_float *ti, nec_float dmin);
nec_float test_simple( nec_float f1r, nec_float f2r, nec_float dmin );
