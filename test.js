function countBinaryStringsNoConsecutiveOnes(n) {
  if (n === 1) return 2;

  // for n = 1
  let end0 = 1; // "0"
  let end1 = 1; // "1"

  for (let i = 2; i <= n; i++) {
    let newEnd0 = end0 + end1;
    let newEnd1 = end0;

    end0 = newEnd0;
    end1 = newEnd1;
  }

  return end0 + end1;
}

// Example
console.log(countBinaryStringsNoConsecutiveOnes(5)); // 13