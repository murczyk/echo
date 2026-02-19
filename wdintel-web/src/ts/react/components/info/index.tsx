import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import { Typography } from '@mui/material';
import clsx from 'clsx';

type InfoProps = {
  text: string;
  className?: string;
  color?: 'primary' | 'error' | 'warning';
};

export function Info(props: InfoProps) {
  return (
    <div className={clsx('flex items-center gap-2', props.className)}>
      <ErrorOutlineIcon className="w-10" color={props.color || 'primary'} />
      <Typography color={props.color || 'primary'} className="!text-sm" component="p">
        {props.text}
      </Typography>
    </div>
  );
}
