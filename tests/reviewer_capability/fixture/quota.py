"""Synthetic proposed helper; defects here are intentional acceptance inputs."""


def reserve(used, amount, limit, save):
    if used + amount < limit:
        try:
            save(used + amount)
        except OSError:
            return {"accepted": True, "used": used}
        return {"accepted": True, "used": used + amount}
    return {"accepted": False, "used": used}
