/*
	Copyright (C) 2004-2005  Timothy C.A. Molteno
	
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
#include "nec_output.h"
#include "nec_exception.h"
#include <cstdarg>
#include <cstdio>
#include <iostream>
#include <string>
#include <sstream>
#include <vector>


/* ---------------------------------------------------------------------*/

nec_output_file::nec_output_file()
  : m_output_fp(NULL), m_output_os(nullptr)
{
	set_error_mode(false);
}

void nec_output_file::set_file(FILE* in_fp)
{
	m_output_fp = in_fp;
	m_output_os = nullptr;
	set_indent(0);
}

void nec_output_file::set_stream(std::ostream& os)
{
	m_output_fp = NULL;
	m_output_os = &os;
	set_indent(0);
}

void nec_output_file::set_error_mode(bool f)
{
	m_error_mode = f;
}

/* private */
void nec_output_file::do_output(const char* str)
{
	if (m_output_os) {
		*m_output_os << str;
		if (m_error_mode)
			*m_output_os << std::flush;
		return;
	}
	if (NULL == m_output_fp)
		return;
	
	fprintf(m_output_fp, "%s", str);
	if (m_error_mode)
		std::cerr << str;
}

void nec_output_file::endl(int n_lines)
{
	for (int i=0; i < n_lines; i++)
		do_output("\n");
		
	m_require_indent = true;
}

void nec_output_file::end_section()
{
	endl(3);
}

void nec_output_file::set_indent(int n)
{
	m_indent = n;
	m_require_indent = true;
	indent();
}

void nec_output_file::indent()
{
	if (m_require_indent)
	{
		for (int i=0; i< m_indent; i++)
			do_output(" ");
		
		m_require_indent = false;
	}
}

void nec_output_file::line(const char* in_str)
{
	string(in_str,true);
}

void nec_output_file::string(const char* in_str, bool require_endl)
{
	indent();
	do_output(in_str);
	if (require_endl)
		endl();
}

void nec_output_file::real(nec_float in_nec_float)
{
	real_out(11,4,in_nec_float,true);
}

void nec_output_file::integer(long in_integer)
{
	nec_printf("%ld", in_integer);
}

void nec_output_file::real_out(int w, int p, nec_float f, bool sci)
{
	std::stringstream ss;
	ss << "%" << w << "." << p;
	
	if (sci)
		ss << "E";
	else
		ss << "f";
	
	std::string s = ss.str();
	const char* fmt = s.c_str();
	
	nec_printf(fmt, f);
}

void nec_output_file::nec_printf(const char* fmt, ...)
{
	if ((NULL == m_output_fp) && (nullptr == m_output_os))
		return;

	va_list sizing_args;
	va_start(sizing_args, fmt);
	const int required = std::vsnprintf(nullptr, 0, fmt, sizing_args);
	va_end(sizing_args);
	if (required < 0)
		throw nec_exception("Unable to format NEC output");

	std::vector<char> buffer(static_cast<size_t>(required) + 1);
	va_list writing_args;
	va_start(writing_args, fmt);
	std::vsnprintf(buffer.data(), buffer.size(), fmt, writing_args);
	va_end(writing_args);
	do_output(buffer.data());
}

