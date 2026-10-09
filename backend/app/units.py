"""Unit conversion. The entered value and unit are stored as given; these
only produce the normalized copy (kg, meters) used for math."""

from decimal import ROUND_HALF_EVEN, Decimal

# Exact by definition (international yard and pound agreement, 1959).
KG_PER = {"kg": Decimal(1), "lb": Decimal("0.45359237")}
M_PER = {"m": Decimal(1), "km": Decimal(1000), "mi": Decimal("1609.344")}


def to_kg(value: Decimal, unit: str) -> Decimal:
    return (value * KG_PER[unit]).quantize(Decimal("0.0001"), ROUND_HALF_EVEN)


def to_m(value: Decimal, unit: str) -> Decimal:
    return (value * M_PER[unit]).quantize(Decimal("0.001"), ROUND_HALF_EVEN)
