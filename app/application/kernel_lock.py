"""统一实例内的读写边界，防止导入保存期间的读取或回滚覆盖并发学习。"""
from functools import wraps
from inspect import getmembers, isfunction, getattr_static


def synchronized_kernel(cls):
    def guarded(method):
        @wraps(method)
        def invoke(self, *args, **kwargs):
            with self._assessment_lock:
                return method(self, *args, **kwargs)
        return invoke
    for name, method in getmembers(cls, isfunction):
        if not name.startswith("_") and not isinstance(getattr_static(cls, name), (staticmethod, classmethod)):
            setattr(cls, name, guarded(method))
    return cls
