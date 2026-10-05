"""Inherited network restrictions for native parsers and LibreOffice."""

import ctypes
import ctypes.util
import errno
import socket


def restrict_network() -> None:
    library = ctypes.util.find_library("seccomp")
    if not library:
        raise RuntimeError("native extraction requires libseccomp")
    seccomp = ctypes.CDLL(library)
    seccomp.seccomp_init.argtypes = [ctypes.c_uint32]
    seccomp.seccomp_init.restype = ctypes.c_void_p
    seccomp.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
    seccomp.seccomp_syscall_resolve_name.restype = ctypes.c_int
    seccomp.seccomp_load.argtypes = [ctypes.c_void_p]
    seccomp.seccomp_release.argtypes = [ctypes.c_void_p]

    class Comparison(ctypes.Structure):
        _fields_ = [
            ("argument", ctypes.c_uint),
            ("operation", ctypes.c_int),
            ("value", ctypes.c_uint64),
            ("mask", ctypes.c_uint64),
        ]

    seccomp.seccomp_rule_add_array.argtypes = [
        ctypes.c_void_p,
        ctypes.c_uint32,
        ctypes.c_int,
        ctypes.c_uint,
        ctypes.POINTER(Comparison),
    ]
    context = seccomp.seccomp_init(0x7FFF0000)
    if not context:
        raise RuntimeError("cannot initialize native sandbox")
    try:
        call = seccomp.seccomp_syscall_resolve_name(b"socket")
        for family in (socket.AF_INET, socket.AF_INET6):
            rule = Comparison(0, 4, family, 0)
            if (
                seccomp.seccomp_rule_add_array(context, 0x00050000 | errno.EPERM, call, 1, ctypes.byref(rule))
                != 0
            ):
                raise RuntimeError("cannot restrict native parser networking")
        if seccomp.seccomp_load(context) != 0:
            raise RuntimeError("cannot enable native parser sandbox")
    finally:
        seccomp.seccomp_release(context)
