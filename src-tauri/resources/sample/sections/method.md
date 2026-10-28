# Method {#sec:method}

Inline math works as usual, $H(X) \ge 0$, and labeled display equations are numbered:

$$H(X) = -\sum_{i=1}^{n} p(x_i) \log_2 p(x_i)$$ {#eq:entropy}

![A sample figure. Add `{.wide}` to span both columns.](figures/example.png){#fig:example width=90%}

## Results

| Model    | Accuracy | Latency (ms) |
|:---------|---------:|-------------:|
| Baseline |    0.812 |           14 |
| Ours     |**0.874** |           11 |

: Results on the test set. {#tbl:results}

Raw LaTeX passes through untouched when you need it: \LaTeX{} rules.
