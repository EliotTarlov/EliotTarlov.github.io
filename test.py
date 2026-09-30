import numpy as np
from time import sleep
DIFFUSION_DIRECTIONS = np.array(((0, 1), (1, 0), (-1, 0), (0, -1)))

def iterate(A: np.ndarray, rng: np.random.Generator, strength: float = 0.01) -> np.ndarray:
    B = np.zeros_like(A)
    ys, xs = np.nonzero(A)
    counts = A[ys, xs]
    total = counts.sum()

    py = np.repeat(ys, counts)
    px = np.repeat(xs, counts)

    cy, cx = A.shape[0] // 2, A.shape[1] // 2 #the center
    dy = cy - py
    dx = cx - px

    dots = (dy[:, None] * DIFFUSION_DIRECTIONS[None, :, 0]
          + dx[:, None] * DIFFUSION_DIRECTIONS[None, :, 1])

    weights = np.exp(dots * strength)
    weights /= weights.sum(axis=1, keepdims=True)

    cdf = np.cumsum(weights, axis=1)
    u = rng.random(total)[:, None]
    choices = (u >= cdf).sum(axis=1)
    dirs = DIFFUSION_DIRECTIONS[choices]

    pos = np.column_stack((py, px))
    new = (pos + dirs) % A.shape

    np.add.at(B, (new[:, 0], new[:, 1]), 1)
    return B
def draw(A: np.ndarray):
    print("\033[H", end="")#moves the cursor home. Ansi controlchars my beloathed
    print(A)
def set_print_options():
    def formatter(i):
        if i<24:
            return f"\033[38;5;{232+i}m#\033[0m" #cursed as hell I'm sorry. This uses ansi codes to print a `#` in a color matching the int at that cell. white is more.
        else:
            return str(i)
    np.set_printoptions(linewidth=np.inf,formatter={'int':formatter})
def main():
    rng = np.random.default_rng()
    set_print_options()
    A=rng.integers(low=0, high=20, size=(25,25),dtype=np.int32)
    #A = np.zeros((25,25),dtype=np.int32)
    #A[5,5]=128
    while True:
        draw(A)
        A=iterate(A, rng)
        sleep(.25)
if __name__=="__main__":
    main()
